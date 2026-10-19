import { Router } from "express";
import crypto from "node:crypto";
import nodemailer from "nodemailer";
import { auth, rtdb, isFirebaseReady } from "../firebase.js";

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function cleanPhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "").replace(/^91(?=\d{10}$)/, "");
  return digits.length === 10 ? digits : "";
}

function validate(body) {
  const errors = {};
  const fullName = String(body?.fullName ?? body?.name ?? "").trim();
  const email = String(body?.email ?? "").trim().toLowerCase();
  const altEmail = String(body?.altEmail ?? "").trim().toLowerCase();
  const school = String(body?.school ?? "").trim();
  const phoneRaw = body?.phone ?? "";
  const ageNum = body?.age === "" || body?.age == null ? null : Number(body.age);
  const password = String(body?.password ?? "");
  const confirm = body?.confirm ?? body?.confirmPassword ?? "";
  const accepted = body?.accepted === true || body?.termsAccepted === true;

  if (fullName.length < 2) errors.fullName = "Please enter your full name.";
  if (!EMAIL_RE.test(email)) errors.email = "Enter a valid email address.";
  if (altEmail && !EMAIL_RE.test(altEmail)) errors.altEmail = "Alternate email looks invalid.";
  else if (altEmail && altEmail === email) errors.altEmail = "Alternate email must differ from primary email.";
  if (school.length < 2) errors.school = "Please tell us your school.";
  else if (school.length > 120) errors.school = "School name is too long.";

  const phone = cleanPhone(phoneRaw);
  if (!phoneRaw || !phone) errors.phone = "Enter a 10-digit contact number.";

  if (ageNum == null || Number.isNaN(ageNum)) errors.age = "Enter your age.";
  else if (ageNum < 10 || ageNum > 100) errors.age = "Age must be between 10 and 100.";

  if (!password || password.length < 8) errors.password = "Password needs at least 8 characters.";
  if (confirm !== password) errors.confirm = "Passwords do not match.";
  if (!accepted) errors.accepted = "Please accept the Terms & Privacy Policy.";

  return {
    errors,
    clean: { fullName, email, altEmail: altEmail || null, school, phone, age: ageNum, password, accepted },
  };
}

// POST /api/auth/register — first API endpoint.
// Body: { fullName, email, altEmail?, phone, age, password, confirm, accepted }
// Creates the Firebase Auth user, writes the member profile to Realtime
// Database `users/{uid}`, and returns a custom token so the new account is
// JOINED (signed in) immediately on the Join Us page.
router.post("/register", async (req, res) => {
  const { errors, clean } = validate(req.body);
  if (Object.keys(errors).length > 0) {
    return res.status(400).json({ ok: false, errors });
  }

  if (!isFirebaseReady()) {
    return res.status(503).json({
      ok: false,
      error: "Firebase is not configured on the backend yet. Set FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY / FIREBASE_DATABASE_URL in Backend/.env.",
    });
  }

  // OTP gate: the primary email must have a fresh verified OTP
  // (POST /api/auth/otp/verify) before an account can be created.
  // Google sign-in skips this — Google already verified that email.
  try {
    const otpCheck = await isEmailOtpVerified(clean.email);
    if (!otpCheck.verified) {
      return res.status(400).json({
        ok: false,
        errors: { email: "Please verify your email with the OTP first — tap Send OTP, enter the 6-digit code, then Verify." },
      });
    }
  } catch (e) {
    console.warn("[register] OTP check skipped (RTDB read failed):", e?.message || e);
    return res.status(503).json({ ok: false, error: "Couldn't check email verification. Try again in a moment." });
  }

  try {
    let record;
    try {
      record = await auth().createUser({
        displayName: clean.fullName,
        email: clean.email,
        password: clean.password,
        emailVerified: false,
        disabled: false,
      });
    } catch (err) {
      if (err?.code === "auth/email-already-exists") {
        return res.status(409).json({ ok: false, errors: { email: "This email already has a Yuvora account. Try signing in." } });
      }
      if (err?.code === "auth/invalid-email" || err?.code === "auth/invalid-password") {
        return res.status(400).json({ ok: false, errors: { email: "Firebase rejected the email/password. Check the fields and retry." } });
      }
      throw err;
    }

    const profile = {
      fullName: clean.fullName,
      email: clean.email,
      altEmail: clean.altEmail,
      school: clean.school,
      phone: clean.phone,
      age: clean.age,
      birthDate: null,
      role: "member",
      termsAcceptedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      provider: "password",
    };
    await rtdb().ref(`users/${record.uid}`).set(profile);

    // Mint the member's stable seed-pass code (YV-XXXX) + reverse index now,
    // so the gate can verify them from any device. Deterministic from uid.
    try {
      let code = null;
      try {
        code = await mintSeedPassCode(record.uid);
      } catch (e) {
        console.warn("[register] seed-pass mint skipped:", e?.message || e);
      }
      if (code) profile.seedPassCode = code;
    } catch (e) {
      console.warn("[register] seed-pass mint failed:", e?.message || e);
    }

    // Custom token lets the frontend sign the user in immediately => "joined".
    const customToken = await auth().createCustomToken(record.uid, { joinedVia: "join-us" });

    // OTP single-use: consume the verification so the same code can't mint
    // a second account.
    try {
      await rtdb().ref(`emailOtps/${otpKeyFor(clean.email)}`).remove();
    } catch {
      /* best-effort cleanup */
    }

    return res.status(201).json({
      ok: true,
      user: { id: record.uid, uid: record.uid, ...profile },
      customToken,
    });
  } catch (err) {
    console.error("POST /api/auth/register failed:", err?.code || err?.message || err);
    return res.status(500).json({ ok: false, error: "Could not create the account. Please try again." });
  }
});

function webApiKey() {
  return String(process.env.FIREBASE_WEB_API_KEY || "").trim();
}

function keyMissing(res) {
  return res.status(503).json({
    ok: false,
    error:
      "Password login is not configured on the backend yet. Add FIREBASE_WEB_API_KEY (Firebase Console > Project settings > General > Web API Key) to Backend/.env and to the Render dashboard, then restart/redeploy.",
  });
}

// Mint the member's stable seed-pass code (YV-XXXX) + reverse index.
// Deterministic from uid, so every new-account entrypoint (register, Google
// sign-in) produces the same code shape. Returns the code or null.
async function mintSeedPassCode(uid) {
  let h = 0x811c9dc5;
  const s = String(uid || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let num = (h % 9000) + 1000;
  for (let tries = 0; tries < 9000; tries++) {
    const candidate = `YV-${String(num)}`;
    const idx = await rtdb().ref(`seedPassIndex/${candidate}`).get();
    const val = idx.val();
    if (!val || val.uid === uid) {
      await rtdb().ref(`users/${uid}`).update({ seedPassCode: candidate });
      await rtdb().ref(`seedPassIndex/${candidate}`).set({ uid });
      return candidate;
    }
    num = num >= 9999 ? 1000 : num + 1;
  }
  return null;
}

// Shared login-success response: merges the RTDB profile with the Auth
// custom-claim role (seeded admins) and returns { user, idToken, refreshToken }.
function mergeClaimRole(profile, uid) {
  return auth().getUser(uid).then((rec) => {
    const merged = { ...(profile || {}) };
    if (rec?.customClaims?.admin === true || rec?.customClaims?.role === "admin") merged.role = "admin";
    return merged;
  }).catch(() => ({ ...(profile || {}) }));
}

// POST /api/auth/login — sign in with an account created via /register.
// Body: { email, password } -> { user, idToken } | 400/401/429
// Verifies the password via the Firebase Auth REST API (Admin SDK cannot
// check passwords), then returns the RTDB profile + ID token.
router.post("/login", async (req, res) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const password = String(req.body?.password ?? "");
  const errors = {};
  if (!EMAIL_RE.test(email)) errors.email = "Enter a valid email address.";
  if (!password) errors.password = "Enter your password.";
  if (Object.keys(errors).length > 0) {
    return res.status(400).json({ ok: false, errors });
  }

  if (!isFirebaseReady()) {
    return res.status(503).json({
      ok: false,
      error: "Firebase is not configured on the backend yet. Set FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY / FIREBASE_DATABASE_URL in Backend/.env.",
    });
  }
  const key = webApiKey();
  if (!key) return keyMissing(res);

  try {
    const r = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
      }
    );
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      const msg = String(data?.error?.message || "");
      if (
        msg.includes("INVALID_LOGIN_CREDENTIALS") ||
        msg.includes("INVALID_PASSWORD") ||
        msg.includes("EMAIL_NOT_FOUND")
      ) {
        return res.status(401).json({ ok: false, errors: { email: "Email or password is wrong." } });
      }
      if (msg.includes("TOO_MANY_ATTEMPTS_TRY_LATER")) {
        return res.status(429).json({ ok: false, error: "Too many attempts. Try again in a few minutes." });
      }
      if (msg.includes("USER_DISABLED")) {
        return res.status(403).json({ ok: false, error: "This account has been disabled. Contact the crew." });
      }
      return res.status(400).json({ ok: false, error: "Couldn't log you in. Try again." });
    }

    const uid = data.localId;
    let profile = null;
    try {
      const snap = await rtdb().ref(`users/${uid}`).get();
      profile = snap.val() || null;
    } catch {
      /* profile optional — auth already succeeded */
    }
    // Merge the Auth custom claim role so seeded admins are recognized
    // even if their RTDB profile was written before `role` existed.
    const merged = await mergeClaimRole(profile, uid);
    return res.json({
      ok: true,
      user: { id: uid, uid, ...merged, email: merged.email || data.email || email },
      idToken: data.idToken,
      // Stored by the frontend: lets it silently mint a fresh ID token when
      // the old one expires, instead of failing admin calls with 401.
      refreshToken: data.refreshToken || null,
    });
  } catch (err) {
    console.error("POST /api/auth/login failed:", err?.code || err?.message || err);
    return res.status(500).json({ ok: false, error: "Couldn't log you in. Try again." });
  }
});

// POST /api/auth/google — "Continue with Google".
// Body: { credential } (the Google ID token JWT from Google Identity Services
// on the frontend). Exchanges it with the Firebase REST API (same provider
// flow as /login) so the response shape is identical: { user, idToken,
// refreshToken }. New Google users get an RTDB profile + seed-pass code
// automatically; returning Google users sign in like /login.
router.post("/google", async (req, res) => {
  const credential = String(req.body?.credential || req.body?.idToken || "").trim();
  if (!credential) {
    return res.status(400).json({ ok: false, error: "Missing Google credential." });
  }

  if (!isFirebaseReady()) {
    return res.status(503).json({
      ok: false,
      error: "Firebase is not configured on the backend yet. Set FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY / FIREBASE_DATABASE_URL in Backend/.env.",
    });
  }
  const key = webApiKey();
  if (!key) return keyMissing(res);

  try {
    // Exchanges the Google ID token with Firebase (providerId google.com).
    // Verifies the JWT server-side; signs in or auto-creates the user.
    const r = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          postBody: `id_token=${encodeURIComponent(credential)}&providerId=google.com`,
          // Required by the REST shape but unused for token-only sign-in.
          requestUri: "http://localhost",
          returnIdpCredential: false,
          returnSecureToken: true,
        }),
      }
    );
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      const msg = String(data?.error?.message || "");
      if (msg.includes("INVALID_IDP_TOKEN") || msg.includes("INVALID_ID_TOKEN")) {
        return res.status(401).json({ ok: false, error: "That Google sign-in expired. Try again." });
      }
      if (msg.includes("EMAIL_EXISTS")) {
        return res.status(409).json({ ok: false, error: "This email already has a Yuvora password account. Log in with your password instead." });
      }
      if (msg.includes("OPERATION_NOT_ALLOWED")) {
        return res.status(503).json({ ok: false, error: "Google sign-in is not enabled yet. Turn it on in Firebase Console > Authentication > Sign-in method." });
      }
      return res.status(400).json({ ok: false, error: "Google sign-in failed. Try again." });
    }

    const uid = data.localId;
    const isNewUser = data.isNewUser === true;
    let mergedProfile = null;

    // First-time Google users get the same RTDB profile the Join form would
    // have written — with the fields Google actually provides. Missing ones
    // (school/phone/age) stay null so the dashboard can nudge to complete.
    if (isNewUser) {
      try {
        const profile = {
          fullName: data.fullName || data.displayName || data.email || "Google member",
          email: String(data.email || "").toLowerCase(),
          photoUrl: data.photoUrl || null,
          school: null,
          phone: null,
          age: null,
          birthDate: null,
          role: "member",
          termsAcceptedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          provider: "google",
        };
        // update() (not set()) so a re-run can never clobber an existing ref.
        await rtdb().ref(`users/${uid}`).update(profile);
        try {
          const code = await mintSeedPassCode(uid);
          if (code) profile.seedPassCode = code;
        } catch (e) {
          console.warn("[google] seed-pass mint skipped:", e?.message || e);
        }
        mergedProfile = profile;
      } catch (e) {
        console.warn("[google] profile write failed:", e?.message || e);
      }
    } else {
      try {
        const snap = await rtdb().ref(`users/${uid}`).get();
        mergedProfile = snap.val() || null;
      } catch {
        /* profile optional — auth already succeeded */
      }
    }

    const merged = await mergeClaimRole(mergedProfile, uid);
    merged.fullName = merged.fullName || data.fullName || data.displayName || "";
    merged.email = merged.email || data.email || "";
    if (!merged.photoUrl && data.photoUrl) merged.photoUrl = data.photoUrl;

    return res.json({
      ok: true,
      user: { id: uid, uid, ...merged },
      idToken: data.idToken,
      refreshToken: data.refreshToken || null,
      isNewUser,
    });
  } catch (err) {
    console.error("POST /api/auth/google failed:", err?.code || err?.message || err);
    return res.status(500).json({ ok: false, error: "Google sign-in failed. Try again." });
  }
});

// POST /api/auth/reset — send a Firebase password-reset email.
// Body: { email } -> { ok: true } (always ok to avoid leaking which emails exist).
router.post("/reset", async (req, res) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ ok: false, errors: { email: "Enter a valid email address." } });
  }
  const key = webApiKey();
  if (!key) return keyMissing(res);
  try {
    await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestType: "PASSWORD_RESET", email }),
      }
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/auth/reset failed:", err?.code || err?.message || err);
    return res.status(500).json({ ok: false, error: "Couldn't send the reset link. Try again." });
  }
});

// POST /api/auth/token — mint a fresh ID token for a live session.
// Body: { customToken? } (Join flow — exchanged once) or
//       { refreshToken? } (login flow — refreshable forever).
// The frontend calls this automatically when an API answers 401, so admin
// actions survive token expiry without forcing a manual re-login.
router.post("/token", async (req, res) => {
  const key = webApiKey();
  if (!key) return keyMissing(res);
  const customToken = String(req.body?.customToken || "");
  const refreshToken = String(req.body?.refreshToken || "");
  if (!customToken && !refreshToken) {
    return res.status(400).json({ ok: false, error: "Nothing to exchange." });
  }
  try {
    if (refreshToken) {
      const r = await fetch(`https://securetoken.googleapis.com/v1/token?key=${key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok || !data?.id_token) {
        return res.status(401).json({ ok: false, error: "Session expired. Please log in again." });
      }
      return res.json({ ok: true, idToken: data.id_token, refreshToken: data.refresh_token || refreshToken });
    }
    const r = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: customToken, returnSecureToken: true }),
      }
    );
    const data = await r.json().catch(() => null);
    if (!r.ok || !data?.idToken) {
      return res.status(401).json({ ok: false, error: "Session expired. Please log in again." });
    }
    return res.json({ ok: true, idToken: data.idToken, refreshToken: data.refreshToken || null });
  } catch (err) {
    console.error("POST /api/auth/token failed:", err?.code || err?.message || err);
    return res.status(500).json({ ok: false, error: "Could not refresh the session. Try again." });
  }
});

// ---------------------------------------------------------------------------
// Email OTP verification (Gmail SMTP via nodemailer).
//
// Flow for Join registration:
//   1. POST /api/auth/otp/request { email } -> 6-digit code emailed, 10-min expiry
//   2. POST /api/auth/otp/verify  { email, otp } -> marks email verified (30-min window)
//   3. POST /api/auth/register    requires a fresh verified OTP (see gate above)
//
// Storage: Realtime Database `emailOtps/{base64url(email)}`:
//   { email, code, expiresAt, attempts, verified, verifiedAt, lastSentAt,
//     requestCount, countWindowStart }
//
// Env (Backend/.env + Render):
//   SMTP_HOST=smtp.gmail.com  SMTP_PORT=587
//   SMTP_USER=yuvoraclub.official@gmail.com
//   SMTP_PASS=<Gmail App Password, NOT the login password>
//   OTP_FROM="Yuvora <yuvoraclub.official@gmail.com>" (optional)
//   OTP_DEV_LOG=1 (optional — log OTPs to console instead of sending, for dev)
// ---------------------------------------------------------------------------

const OTP_TTL_MS = 10 * 60 * 1000; // code valid 10 min
const OTP_VERIFIED_WINDOW_MS = 30 * 60 * 1000; // verified flag valid 30 min
const OTP_RESEND_MS = 60 * 1000; // 60s between sends
const OTP_MAX_PER_HOUR = 5;
const OTP_MAX_ATTEMPTS = 5;

function otpKeyFor(email) {
  return Buffer.from(String(email || "").trim().toLowerCase()).toString("base64url");
}

function smtpConfig() {
  const user = String(process.env.SMTP_USER || "").trim();
  const pass = String(process.env.SMTP_PASS || "").trim();
  return {
    host: String(process.env.SMTP_HOST || "smtp.gmail.com").trim(),
    port: Number(process.env.SMTP_PORT || 587),
    user,
    pass,
    from: String(process.env.OTP_FROM || user || "Yuvora <no-reply@yuvora.org>").trim(),
    devLog: String(process.env.OTP_DEV_LOG || "").trim() === "1",
    configured: Boolean(user && pass),
  };
}

async function sendOtpEmail(to, code) {
  const cfg = smtpConfig();
  if (cfg.devLog || !cfg.configured) {
    console.log(`[otp] DEV — code for ${to}: ${code} (SMTP ${cfg.configured ? "configured but OTP_DEV_LOG=1" : "NOT configured — set SMTP_USER/SMTP_PASS"})`);
    return { sent: false, devLogged: true };
  }
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    auth: { user: cfg.user, pass: cfg.pass },
  });
  await transporter.sendMail({
    from: cfg.from,
    to,
    subject: "Yuvora — your verification code",
    text: `Your Yuvora verification code is ${code}.\n\nIt expires in 10 minutes. If you didn't ask for this, ignore this email.\n\n— Yuvora crew`,
    html: `<div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;padding:24px;background:#faf6ec;border:1.5px solid #e3d5b8;border-radius:14px"><p style="font-size:13px;letter-spacing:.12em;color:#8a6f3c;margin:0">❧ YUVORA · EMAIL VERIFICATION</p><h2 style="margin:8px 0 4px">Your code is</h2><p style="font-size:42px;font-weight:800;letter-spacing:.28em;margin:8px 0;color:#2e332c">${code}</p><p style="color:#5c6758;font-size:14px;line-height:1.6">Enter this on the Join page. It expires in <b>10 minutes</b>. If you didn't ask for this, just ignore this email.</p><p style="font-size:12px;color:#9aa392">— the Yuvora crew · grown, not built</p></div>`,
  });
  return { sent: true };
}

async function isEmailOtpVerified(email) {
  const key = otpKeyFor(email);
  const snap = await rtdb().ref(`emailOtps/${key}`).get();
  const rec = snap.val() || null;
  if (!rec || rec.verified !== true || !rec.verifiedAt) return { verified: false };
  if (Date.now() - Number(rec.verifiedAt) > OTP_VERIFIED_WINDOW_MS) return { verified: false, expired: true };
  return { verified: true };
}

// POST /api/auth/otp/request — send (or resend) a 6-digit code to the email.
router.post("/otp/request", async (req, res) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ ok: false, errors: { email: "Enter a valid email address first." } });
  }
  if (!isFirebaseReady()) {
    return res.status(503).json({ ok: false, error: "Verification service is warming up. Try again in a moment." });
  }
  const cfg = smtpConfig();
  if (!cfg.configured && !cfg.devLog) {
    return res.status(503).json({
      ok: false,
      error: "Email verification is not switched on yet. Ask the crew to set SMTP_USER / SMTP_PASS on the backend.",
    });
  }
  try {
    const key = otpKeyFor(email);
    const ref = rtdb().ref(`emailOtps/${key}`);
    const snap = await ref.get();
    const prev = snap.val() || null;
    const now = Date.now();

    if (prev?.lastSentAt && now - Number(prev.lastSentAt) < OTP_RESEND_MS) {
      const wait = Math.ceil((OTP_RESEND_MS - (now - Number(prev.lastSentAt))) / 1000);
      return res.status(429).json({ ok: false, error: `Wait ${wait}s before asking for a new code.`, retryAfter: wait });
    }
    let requestCount = 1;
    let countWindowStart = now;
    if (prev?.countWindowStart && now - Number(prev.countWindowStart) < 60 * 60 * 1000) {
      requestCount = Number(prev.requestCount || 0) + 1;
      countWindowStart = Number(prev.countWindowStart);
      if (requestCount > OTP_MAX_PER_HOUR) {
        return res.status(429).json({ ok: false, error: "Too many codes sent. Try again in an hour." });
      }
    }

    const code = String(crypto.randomInt(100000, 1000000));
    await ref.set({
      email,
      code,
      expiresAt: now + OTP_TTL_MS,
      attempts: 0,
      verified: false,
      verifiedAt: null,
      lastSentAt: now,
      requestCount,
      countWindowStart,
    });

    try {
      await sendOtpEmail(email, code);
    } catch (e) {
      console.error("POST /api/auth/otp/request send failed:", e?.message || e);
      return res.status(500).json({ ok: false, error: "Couldn't send the email. Check the address and try again." });
    }
    return res.json({ ok: true, expiresIn: OTP_TTL_MS / 1000 });
  } catch (err) {
    console.error("POST /api/auth/otp/request failed:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Couldn't send the code. Try again." });
  }
});

// POST /api/auth/otp/verify — check the 6-digit code, mark email verified.
router.post("/otp/verify", async (req, res) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const otp = String(req.body?.otp ?? req.body?.code ?? "").replace(/\D/g, "");
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ ok: false, errors: { email: "Enter a valid email address." } });
  }
  if (!/^\d{6}$/.test(otp)) {
    return res.status(400).json({ ok: false, errors: { otp: "Enter the 6-digit code from your email." } });
  }
  if (!isFirebaseReady()) {
    return res.status(503).json({ ok: false, error: "Verification service is warming up. Try again in a moment." });
  }
  try {
    const key = otpKeyFor(email);
    const ref = rtdb().ref(`emailOtps/${key}`);
    const snap = await ref.get();
    const rec = snap.val() || null;
    if (!rec || !rec.code) {
      return res.status(400).json({ ok: false, errors: { otp: "No code was sent to this email. Tap Send OTP first." } });
    }
    const now = Date.now();
    if (rec.verified === true && rec.verifiedAt && now - Number(rec.verifiedAt) < OTP_VERIFIED_WINDOW_MS) {
      return res.json({ ok: true, already: true });
    }
    if (now > Number(rec.expiresAt)) {
      return res.status(400).json({ ok: false, errors: { otp: "That code expired. Tap Send OTP for a fresh one." } });
    }
    if (Number(rec.attempts || 0) >= OTP_MAX_ATTEMPTS) {
      return res.status(429).json({ ok: false, errors: { otp: "Too many wrong tries. Tap Send OTP for a fresh code." } });
    }
    if (String(rec.code) !== otp) {
      const attempts = Number(rec.attempts || 0) + 1;
      await ref.update({ attempts });
      const left = Math.max(0, OTP_MAX_ATTEMPTS - attempts);
      return res.status(400).json({ ok: false, errors: { otp: `Wrong code. ${left} ${left === 1 ? "try" : "tries"} left before you need a fresh code.` } });
    }
    await ref.update({ verified: true, verifiedAt: now });
    return res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/auth/otp/verify failed:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Couldn't check the code. Try again." });
  }
});

export default router;
