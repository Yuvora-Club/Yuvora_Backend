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

export default router;
