// Admin user management.
// All routes below require an admin ID token (see middleware/requireAdmin.js).
//   GET  /api/admin/me    -> the caller's own admin profile
//   GET  /api/admin/users -> every profile in `users/` (admins first)
//   POST /api/admin/users -> create a Firebase Auth user + `users/{uid}`
//                            profile with role "admin" (dynamic add-user page).

import { Router } from "express";
import { auth, rtdb, isFirebaseReady } from "../firebase.js";
import { requireAdmin } from "../middleware/requireAdmin.js";

const router = Router();

router.use(requireAdmin);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function cleanPhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "").replace(/^91(?=\d{10}$)/, "");
  return digits.length === 10 ? digits : "";
}

// Age from an ISO birth date (YYYY-MM-DD). Birthday-aware — increments
// automatically every year, so the stored age never goes stale.
export function ageFromBirthDate(birthDate, now = new Date()) {
  const m = String(birthDate || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!y || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  let age = now.getFullYear() - y;
  const beforeBirthday =
    now.getMonth() + 1 < mo || (now.getMonth() + 1 === mo && now.getDate() < d);
  if (beforeBirthday) age -= 1;
  return age >= 0 && age <= 120 ? age : null;
}

function validateNewAdmin(body) {
  const errors = {};
  const fullName = String(body?.fullName ?? body?.name ?? "").trim();
  const email = String(body?.email ?? "").trim().toLowerCase();
  const phone = cleanPhone(body?.phone ?? "");
  const birthDate = String(body?.birthDate ?? "").trim();
  const password = String(body?.password ?? "");
  if (fullName.length < 2) errors.fullName = "Please enter the admin's full name.";
  if (!EMAIL_RE.test(email)) errors.email = "Enter a valid email address.";
  if (!phone) errors.phone = "Enter a 10-digit contact number.";
  let age = null;
  if (birthDate) {
    age = ageFromBirthDate(birthDate);
    if (age == null) errors.birthDate = "Birth date must be YYYY-MM-DD (e.g. 2011-03-14).";
  } else if (body?.age !== "" && body?.age != null) {
    const n = Number(body.age);
    if (!Number.isFinite(n) || n < 10 || n > 100) errors.age = "Age must be between 10 and 100.";
    else age = Math.floor(n);
  } else {
    errors.birthDate = "Give a birth date (age is computed from it).";
  }
  if (!password || password.length < 8) errors.password = "Password needs at least 8 characters.";
  return { errors, clean: { fullName, email, phone, birthDate: birthDate || null, age, password } };
}

function publicProfile(uid, p) {
  if (!p) return null;
  return {
    id: uid,
    uid,
    fullName: p.fullName || "",
    email: p.email || "",
    phone: p.phone || "",
    birthDate: p.birthDate || null,
    age: p.birthDate ? ageFromBirthDate(p.birthDate) ?? p.age ?? null : (p.age ?? null),
    role: p.role || "member",
    createdAt: p.createdAt || null,
  };
}

// Caller's own profile — powers the "Profile" tab on the admin page.
router.get("/me", async (req, res) => {
  try {
    const snap = await rtdb().ref(`users/${req.admin.uid}`).get();
    return res.json({ ok: true, admin: publicProfile(req.admin.uid, snap.val()) });
  } catch (err) {
    console.error("GET /api/admin/me failed:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Could not load the admin profile." });
  }
});

// Directory of users (admins first, then newest). Powers the Add User page list.
router.get("/users", async (_req, res) => {
  try {
    const snap = await rtdb().ref("users").get();
    const val = snap.val() || {};
    const users = Object.entries(val).map(([uid, p]) => publicProfile(uid, p || {}));
    users.sort((a, b) => {
      const ar = a.role === "admin" ? 0 : 1;
      const br = b.role === "admin" ? 0 : 1;
      if (ar !== br) return ar - br;
      return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
    });
    return res.json({ ok: true, users });
  } catch (err) {
    console.error("GET /api/admin/users failed:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Could not list users." });
  }
});

// Dynamically add a user WITH admin powers (the sidebar "Add User" page).
router.post("/users", async (req, res) => {
  if (!isFirebaseReady()) {
    return res.status(503).json({ ok: false, error: "Firebase is not configured on the backend yet." });
  }
  const { errors, clean } = validateNewAdmin(req.body);
  if (Object.keys(errors).length > 0) return res.status(400).json({ ok: false, errors });

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
        return res.status(409).json({ ok: false, errors: { email: "This email already has an account." } });
      }
      throw err;
    }

    await auth().setCustomUserClaims(record.uid, { admin: true, role: "admin" });

    const now = new Date().toISOString();
    const profile = {
      fullName: clean.fullName,
      email: clean.email,
      altEmail: null,
      phone: clean.phone,
      birthDate: clean.birthDate,
      age: clean.age,
      role: "admin",
      termsAcceptedAt: now,
      createdAt: now,
      createdBy: req.admin.uid,
      provider: "password",
    };
    await rtdb().ref(`users/${record.uid}`).set(profile);
    return res.status(201).json({ ok: true, user: publicProfile(record.uid, profile) });
  } catch (err) {
    console.error("POST /api/admin/users failed:", err?.code || err?.message || err);
    return res.status(500).json({ ok: false, error: "Could not create the admin user." });
  }
});

// ---- Change own credentials (Profile tab -> "Login credentials") ----
// Both endpoints re-verify the CURRENT password via Firebase before changing
// anything, so a stolen/leftover admin session alone cannot hijack the account.

function webApiKey() {
  return String(process.env.FIREBASE_WEB_API_KEY || "").trim();
}

// Returns the Firebase user record for the caller, or sends 401 when the
// supplied current password is wrong. Null = response already sent.
async function verifyCurrentPassword(req, res, currentPassword) {
  const key = webApiKey();
  if (!key) {
    res.status(503).json({
      ok: false,
      error: "Password checks are not configured on the backend yet. Add FIREBASE_WEB_API_KEY.",
    });
    return null;
  }
  let profileEmail = null;
  try {
    const snap = await rtdb().ref(`users/${req.admin.uid}`).get();
    profileEmail = (snap.val() && snap.val().email) || null;
  } catch {
    profileEmail = null;
  }
  const email = (profileEmail || req.admin.email || "").toLowerCase();
  if (!email) {
    res.status(400).json({ ok: false, errors: { password: "Could not find your account email." } });
    return null;
  }
  try {
    const r = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: String(currentPassword || ""), returnSecureToken: true }),
      }
    );
    if (!r.ok) {
      res.status(401).json({ ok: false, errors: { password: "Current password is wrong." } });
      return null;
    }
  } catch {
    res.status(500).json({ ok: false, error: "Could not verify the current password. Try again." });
    return null;
  }
  return { uid: req.admin.uid, email };
}

// PUT /api/admin/credentials/email { newEmail, password } — change login email.
router.put("/credentials/email", async (req, res) => {
  const newEmail = String(req.body?.newEmail ?? req.body?.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(newEmail)) {
    return res.status(400).json({ ok: false, errors: { newEmail: "Enter a valid new email address." } });
  }
  const who = await verifyCurrentPassword(req, res, req.body?.password);
  if (!who) return;
  if (newEmail === who.email) {
    return res.status(400).json({ ok: false, errors: { newEmail: "This is already your login email." } });
  }
  try {
    await auth().updateUser(who.uid, { email: newEmail });
    await rtdb().ref(`users/${who.uid}`).update({ email: newEmail, updatedAt: new Date().toISOString() });
    const snap = await rtdb().ref(`users/${who.uid}`).get();
    return res.json({ ok: true, admin: publicProfile(who.uid, snap.val()) });
  } catch (err) {
    if (err?.code === "auth/email-already-exists") {
      return res.status(409).json({ ok: false, errors: { newEmail: "This email already has an account." } });
    }
    console.error("PUT /api/admin/credentials/email failed:", err?.code || err?.message || err);
    return res.status(500).json({ ok: false, error: "Could not change the email." });
  }
});

// PUT /api/admin/credentials/password { currentPassword, newPassword }.
router.put("/credentials/password", async (req, res) => {
  const currentPassword = String(req.body?.currentPassword ?? req.body?.password ?? "");
  const newPassword = String(req.body?.newPassword ?? "");
  if (!currentPassword) {
    return res.status(400).json({ ok: false, errors: { password: "Enter your current password." } });
  }
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ ok: false, errors: { newPassword: "New password needs at least 8 characters." } });
  }
  if (newPassword === currentPassword) {
    return res.status(400).json({ ok: false, errors: { newPassword: "New password must differ from the current one." } });
  }
  const who = await verifyCurrentPassword(req, res, currentPassword);
  if (!who) return;
  try {
    await auth().updateUser(who.uid, { password: newPassword });
    // Existing sessions stay valid until their tokens expire, so the frontend
    // signs out immediately and asks for a fresh login with the new password.
    await auth().revokeRefreshTokens(who.uid);
    return res.json({ ok: true });
  } catch (err) {
    console.error("PUT /api/admin/credentials/password failed:", err?.code || err?.message || err);
    return res.status(500).json({ ok: false, error: "Could not change the password." });
  }
});

export default router;
