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
  const school = String(body?.school ?? "").trim();
  const phone = cleanPhone(body?.phone ?? "");
  const birthDate = String(body?.birthDate ?? "").trim();
  const password = String(body?.password ?? "");
  if (fullName.length < 2) errors.fullName = "Please enter the admin's full name.";
  if (!EMAIL_RE.test(email)) errors.email = "Enter a valid email address.";
  if (school.length < 2) errors.school = "Please tell us their school.";
  else if (school.length > 120) errors.school = "School name is too long.";
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
  return { errors, clean: { fullName, email, school, phone, birthDate: birthDate || null, age, password } };
}

// Seed passes — gate verification for raves / socials.
// Every member gets a stable `seedPassCode` (format YV-XXXX, e.g. YV-8930)
// minted at registration. Admins verify + consume it at the gate.
//
// Storage (Realtime Database):
//   users/{uid}.seedPassCode            stable per-member code (YV-XXXX)
//   seedPassIndex/{CODE} -> { uid }     reverse lookup for instant gate verify
//   seedPassScans/{pushId}              audit log of gate scans
// Routes (all requireAdmin):
//   POST /api/admin/seedpass/verify { code }  -> member profile + scan history
//   POST /api/admin/seedpass/consume { code, note? } -> marks used (idempotent-ish, logs every scan)

function seedPassCodeFromUid(uid) {
  // Stable + deterministic so re-reads never rotate a member's printed code.
  // Simple FNV-ish hash of the uid -> YV-1000..YV-9999 (9000 slots; collisions
  // fall back to a per-user suffix resolved at ensure-time).
  let h = 0x811c9dc5;
  const s = String(uid || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `YV-${String((h % 9000) + 1000)}`;
}

async function ensureSeedPassCode(uid) {
  const userRef = rtdb().ref(`users/${uid}`);
  const snap = await userRef.get();
  const profile = snap.val();
  if (!profile) return null;
  let code = String(profile.seedPassCode || "").trim().toUpperCase();
  if (/^YV-\d{4}$/.test(code)) {
    // Repair the reverse index if missing.
    try {
      const idx = await rtdb().ref(`seedPassIndex/${code}`).get();
      if (!idx.exists()) await rtdb().ref(`seedPassIndex/${code}`).set({ uid });
    } catch { /* index repair is best-effort */ }
    return code;
  }
  // Mint: deterministic base, bump on collision with another uid's code.
  let base = seedPassCodeFromUid(uid);
  let num = Number(base.slice(3));
  for (let tries = 0; tries < 9000; tries++) {
    const candidate = `YV-${String(num)}`;
    const idx = await rtdb().ref(`seedPassIndex/${candidate}`).get();
    const val = idx.val();
    if (!val || val.uid === uid) {
      await userRef.update({ seedPassCode: candidate });
      await rtdb().ref(`seedPassIndex/${candidate}`).set({ uid });
      return candidate;
    }
    num = num >= 9999 ? 1000 : num + 1;
  }
  return null;
}

// Gate scan history for a code. Deliberately a plain ref().get() + JS filter
// instead of orderByChild().equalTo().get(): the chained Query.get() is not
// present on every firebase-admin build (Reference.get() always is), and an
// unindexed child query needs a declared .indexOn. History is non-critical —
// a failure here must never fail a verify/consume.
async function scansForCode(code) {
  try {
    const snap = await rtdb().ref("seedPassScans").get();
    const all = snap.val() || {};
    return Object.entries(all)
      .filter(([, s]) => String(s?.code || "").trim().toUpperCase() === code)
      .map(([id, s]) => ({ id, ...s }))
      .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
  } catch (err) {
    console.warn("[seedpass] scans load failed:", err?.message || err);
    return [];
  }
}

function publicProfile(uid, p) {
  if (!p) return null;
  return {
    id: uid,
    uid,
    fullName: p.fullName || "",
    email: p.email || "",
    school: p.school || "",
    phone: p.phone || "",
    birthDate: p.birthDate || null,
    age: p.birthDate ? ageFromBirthDate(p.birthDate) ?? p.age ?? null : (p.age ?? null),
    role: p.role || "member",
    seedPassCode: p.seedPassCode || null,
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
      school: clean.school,
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

// ---- Edit own profile (Profile tab). ONLY these four fields are writable:
// phone, birthDate, age, role. Name/email stay fixed so the admin identity
// can't be morphed by accident.
//   PUT /api/admin/profile { phone?, birthDate?, age?, role? }
// Age rule: when birthDate is present, age is always recomputed from it
// (birthday-aware, auto-increments yearly); a manual age is stored only when
// there is no birth date.

function cleanPhoneInput(raw) {
  const digits = String(raw || "").replace(/\D/g, "").replace(/^91(?=\d{10}$)/, "");
  return digits.length === 10 ? digits : "";
}

// PUT /api/admin/profile — update own phone / birthDate / age / role.
router.put("/profile", async (req, res) => {
  const errors = {};
  const patch = {};
  const body = req.body || {};

  if (body.phone !== undefined) {
    const phone = cleanPhoneInput(body.phone);
    if (!phone) errors.phone = "Enter a 10-digit contact number.";
    else patch.phone = phone;
  }

  let birthDate = null;
  if (body.birthDate !== undefined) {
    birthDate = String(body.birthDate || "").trim();
    if (birthDate) {
      const age = ageFromBirthDate(birthDate);
      if (age == null) errors.birthDate = "Birth date must be YYYY-MM-DD (e.g. 2011-03-14).";
      else {
        patch.birthDate = birthDate;
        patch.age = age; // birth date always wins over a manual age
      }
    } else {
      patch.birthDate = null; // cleared -> manual age below (if given) applies
    }
  }

  if (body.age !== undefined && body.age !== "" && body.age !== null) {
    const n = Number(body.age);
    if (!Number.isFinite(n) || n < 10 || n > 100) errors.age = "Age must be between 10 and 100.";
    else if (!patch.birthDate) patch.age = Math.floor(n); // birth date wins when set
  }

  if (body.role !== undefined) {
    const role = String(body.role || "").trim();
    if (role !== "admin" && role !== "member") errors.role = "Role must be admin or member.";
    else patch.role = role;
  }

  if (Object.keys(errors).length > 0) return res.status(400).json({ ok: false, errors });
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ ok: false, error: "Nothing to update." });
  }

  try {
    // Never strand the club with zero admins: block self-demotion when this
    // admin is the last one standing.
    if (patch.role === "member") {
      const all = (await rtdb().ref("users").get()).val() || {};
      const otherAdmins = Object.entries(all).filter(
        ([uid, p]) => uid !== req.admin.uid && p && p.role === "admin"
      );
      if (otherAdmins.length === 0) {
        return res.status(400).json({
          ok: false,
          errors: { role: "You are the last admin — promote someone else first." },
        });
      }
    }

    patch.updatedAt = new Date().toISOString();
    await rtdb().ref(`users/${req.admin.uid}`).update(patch);

    // Keep the Auth display name / claims consistent when role changes.
    if (patch.role) {
      const claims = patch.role === "admin" ? { admin: true, role: "admin" } : {};
      await auth().setCustomUserClaims(req.admin.uid, claims);
    }

    const snap = await rtdb().ref(`users/${req.admin.uid}`).get();
    return res.json({ ok: true, admin: publicProfile(req.admin.uid, snap.val()) });
  } catch (err) {
    console.error("PUT /api/admin/profile failed:", err?.code || err?.message || err);
    return res.status(500).json({ ok: false, error: "Could not update the profile." });
  }
});

// ---- Seed-pass gate (Verify tab in /admin) ----
// POST /api/admin/seedpass/verify { code } -> member profile + scan history.
// Code format: YV-XXXX (case-insensitive, dash optional). Mint-on-first-verify
// so members who joined before this feature still get a stable code.
router.post("/seedpass/verify", async (req, res) => {
  const raw = String(req.body?.code || "").trim().toUpperCase().replace(/\s+/g, "");
  const m = raw.match(/^YV-?(\d{3,6})$/);
  if (!m) return res.status(400).json({ ok: false, error: "Enter a seed-pass code like YV-8930." });
  const code = `YV-${m[1].padStart(4, "0").slice(-4)}`;
  if (!isFirebaseReady()) {
    return res.status(503).json({ ok: false, error: "Firebase is not configured on the backend yet." });
  }
  try {
    // 1) Reverse index (fast path).
    let uid = null;
    const idxSnap = await rtdb().ref(`seedPassIndex/${code}`).get();
    const idxUid = idxSnap.val()?.uid || null;
    if (idxUid) {
      const prof = await rtdb().ref(`users/${idxUid}`).get();
      // Only trust the index if that member still exists (guards against
      // pruned users leaving a dangling index entry that would 404).
      if (prof.exists()) uid = idxUid;
    }
    // 2) Fallback — sweep users for a stored code (also repairs the index).
    if (!uid) {
      const usersSnap = await rtdb().ref("users").get();
      const users = usersSnap.val() || {};
      for (const [id, p] of Object.entries(users)) {
        if (String(p?.seedPassCode || "").trim().toUpperCase() === code) {
          uid = id;
          try {
            await rtdb().ref(`seedPassIndex/${code}`).set({ uid: id });
          } catch { /* index repair is best-effort */ }
          break;
        }
      }
    }
    if (!uid) {
      console.warn(`[seedpass] verify miss: ${code} — not in seedPassIndex nor any users/*.`);
      return res.status(404).json({
        ok: false,
        error: `No member found for ${code}. If this member's dashboard shows this code, the backend serving the dashboard and this one are using different databases.`,
      });
    }
    const codeNow = await ensureSeedPassCode(uid);
    const profSnap = await rtdb().ref(`users/${uid}`).get();
    const profile = profSnap.val();
    if (!profile) return res.status(404).json({ ok: false, error: `No member found for ${code}.` });
    // Recent scans for this code (same gate, any admin).
    const scans = (await scansForCode(code)).slice(0, 10);
    return res.json({
      ok: true,
      pass: {
        code: codeNow || code,
        status: scans.length > 0 ? "scanned" : "active",
        scanCount: scans.length,
      },
      member: { ...publicProfile(uid, profile), seedPassCode: codeNow || code },
      scans,
    });
  } catch (err) {
    console.error("POST /api/admin/seedpass/verify failed:", err?.stack || err?.message || err);
    return res.status(500).json({
      ok: false,
      error: "Could not verify that code. Try again.",
      detail: err?.message || String(err),
    });
  }
});

// POST /api/admin/seedpass/consume { code, note? } -> logs a gate entry scan.
// Every scan is logged; the response tells the gate if this code was already
// scanned before (possible double-use) so the admin can decide.
router.post("/seedpass/consume", async (req, res) => {
  const raw = String(req.body?.code || "").trim().toUpperCase().replace(/\s+/g, "");
  const note = String(req.body?.note || "").trim().slice(0, 200);
  const m = raw.match(/^YV-?(\d{3,6})$/);
  if (!m) return res.status(400).json({ ok: false, error: "Enter a seed-pass code like YV-8930." });
  const code = `YV-${m[1].padStart(4, "0").slice(-4)}`;
  if (!isFirebaseReady()) {
    return res.status(503).json({ ok: false, error: "Firebase is not configured on the backend yet." });
  }
  try {
    // Resolve the member the same resilient way as verify: trust the reverse
    // index only if that member still exists, else sweep users for the code.
    let uid = null;
    const idxSnap = await rtdb().ref(`seedPassIndex/${code}`).get();
    const idxUid = idxSnap.val()?.uid || null;
    if (idxUid) {
      const prof = await rtdb().ref(`users/${idxUid}`).get();
      if (prof.exists()) uid = idxUid;
    }
    if (!uid) {
      const usersSnap = await rtdb().ref("users").get();
      const users = usersSnap.val() || {};
      for (const [id, p] of Object.entries(users)) {
        if (String(p?.seedPassCode || "").trim().toUpperCase() === code) {
          uid = id;
          try {
            await rtdb().ref(`seedPassIndex/${code}`).set({ uid: id });
          } catch { /* index repair is best-effort */ }
          break;
        }
      }
    }
    if (!uid) {
      console.warn(`[seedpass] consume miss: ${code} — not in seedPassIndex nor any users/*.`);
      return res.status(404).json({ ok: false, error: `No member found for ${code}.` });
    }
    const codeNow = await ensureSeedPassCode(uid);
    const profSnap = await rtdb().ref(`users/${uid}`).get();
    const profile = profSnap.val();
    if (!profile) return res.status(404).json({ ok: false, error: `No member found for ${code}.` });
    const priorCount = (await scansForCode(code)).length;
    const at = new Date().toISOString();
    await rtdb().ref("seedPassScans").push({
      code,
      uid,
      by: req.admin.uid,
      at,
      note: note || null,
    });
    return res.json({
      ok: true,
      pass: {
        code: codeNow || code,
        status: "scanned",
        scanCount: priorCount + 1,
        alreadyScanned: priorCount > 0,
        at,
      },
      member: { ...publicProfile(uid, profile), seedPassCode: codeNow || code },
    });
  } catch (err) {
    console.error("POST /api/admin/seedpass/consume failed:", err?.stack || err?.message || err);
    return res.status(500).json({
      ok: false,
      error: "Could not record that scan. Try again.",
      detail: err?.message || String(err),
    });
  }
});

export default router;
