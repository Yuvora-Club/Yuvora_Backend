// Admin user management.
// All routes below require an admin ID token (see middleware/requireAdmin.js).
// Only assigned admins (users/{uid}.role === "admin" or an admin custom
// claim) can reach ANY route in this file — members get 403.
//   GET  /api/admin/me    -> the caller's own admin profile
//   GET  /api/admin/users -> every profile in `users/` (admins first)
//   POST /api/admin/users -> create a Firebase Auth user + `users/{uid}`
//                            profile with role "admin" (dynamic add-user page).
//   GET  /api/admin/plans       -> every club future-plan todo (admin-only)
//   POST /api/admin/plans       -> create a future-plan todo
//   PUT  /api/admin/plans/:id   -> update a future-plan todo
//   DELETE /api/admin/plans/:id -> delete a future-plan todo

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
  const role = String(body?.role ?? "admin").trim().toLowerCase();
  if (fullName.length < 2) errors.fullName = "Please enter the admin's full name.";
  if (!EMAIL_RE.test(email)) errors.email = "Enter a valid email address.";
  if (school.length < 2) errors.school = "Please tell us their school.";
  else if (school.length > 120) errors.school = "School name is too long.";
  if (!phone) errors.phone = "Enter a 10-digit contact number.";
  if (role !== "admin" && role !== "member") errors.role = "Role must be admin or member.";
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
  return { errors, clean: { fullName, email, school, phone, birthDate: birthDate || null, age, password, role } };
}

// Seed passes — membership check for the Verify tab (gate / social entry).
// Every member gets a stable `seedPassCode` (format YV-XXXX, e.g. YV-8930)
// minted at registration. The admin types it in: the endpoint is a pure READ —
// does this person belong, who are they, which events are they registered in.
// Nothing is ever written here (no scan/marking log).
//
// Storage (Realtime Database):
//   users/{uid}.seedPassCode            stable per-member code (YV-XXXX)
//   seedPassIndex/{CODE}                reverse lookup, self-describing:
//                                       { uid, fullName, email, updatedAt }
//   eventRegs/{eventId}/{uid}           individual event registrations
//   teams/{teamId}.members/{uid}        team rosters (sport + general teams)
// Routes (all requireAdmin):
//   POST /api/admin/seedpass/verify { code }  -> member profile + registered events

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
  const who = {
    uid,
    fullName: String(profile.fullName || profile.name || ""),
    email: String(profile.email || "").toLowerCase(),
    updatedAt: new Date().toISOString(),
  };
  let code = String(profile.seedPassCode || "").trim().toUpperCase();
  if (/^YV-\d{4}$/.test(code)) {
    // Repair the reverse index if missing — or top up an old anonymous
    // { uid } entry with the owner's name+email so the index stays
    // self-describing.
    try {
      const idx = await rtdb().ref(`seedPassIndex/${code}`).get();
      const val = idx.val();
      if (!val) await rtdb().ref(`seedPassIndex/${code}`).set(who);
      else if (val.uid === uid && (!val.fullName || !val.email)) {
        await rtdb().ref(`seedPassIndex/${code}`).update({
          fullName: who.fullName,
          email: who.email,
          updatedAt: who.updatedAt,
        });
      }
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
      await rtdb().ref(`seedPassIndex/${candidate}`).set(who);
      return candidate;
    }
    num = num >= 9999 ? 1000 : num + 1;
  }
  return null;
}

// Every event a member is registered in. Two sources, both plain ref().get()
// + JS filter (never chained orderByChild().equalTo() queries — those hard-
// throw without declared .indexOn rules). Read-only and non-critical: a
// failure here returns null and must never fail a verify.
//   eventRegs/{eventId}/{uid}        individual entries (general events)
//   teams/{teamId}.members/{uid}     team rosters (sport events + general teams)
async function memberRegisteredEvents(uid) {
  try {
    const [regsSnap, teamsSnap, gevsSnap, sevsSnap] = await Promise.all([
      rtdb().ref("eventRegs").get(),
      rtdb().ref("teams").get(),
      rtdb().ref("generalEvents").get(),
      rtdb().ref("sportEvents").get(),
    ]);
    const regs = regsSnap.val() || {};
    const teams = teamsSnap.val() || {};
    const generalEvents = gevsSnap.val() || {};
    const sportEvents = sevsSnap.val() || {};
    const events = [];
    for (const [eventId, byUser] of Object.entries(regs)) {
      const mine = byUser && byUser[uid];
      if (!mine) continue;
      events.push({
        eventId,
        name: generalEvents[eventId]?.title || eventId,
        type: "individual",
        sport: null,
        teamName: null,
        teamId: null,
        when: mine.registeredAt || null,
      });
    }
    for (const [teamId, t] of Object.entries(teams)) {
      const me = t?.members && t.members[uid];
      if (!me) continue;
      const isGeneral = String(t.sportId || "") === "general";
      const ev = isGeneral ? generalEvents[t.eventId] : sportEvents[t.eventId];
      events.push({
        eventId: t.eventId,
        name: ev?.title || t.eventId,
        type: "team",
        sport: isGeneral ? null : t.sportId || null,
        teamName: t.name || null,
        teamId,
        when: me.joinedAt || t.createdAt || null,
      });
    }
    events.sort((a, b) => String(b.when || "").localeCompare(String(a.when || "")));
    return events;
  } catch (err) {
    console.warn("[seedpass] registrations load failed:", err?.message || err);
    return null;
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

// Dynamically add a user WITH an assigned role (the sidebar "Add User" page).
// Role is fixed AT CREATION: "admin" can open /admin, "member" cannot.
// Only an existing assigned admin (requireAdmin above) can call this.
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

    await auth().setCustomUserClaims(record.uid, clean.role === "admin" ? { admin: true, role: "admin" } : {});

    const now = new Date().toISOString();
    const profile = {
      fullName: clean.fullName,
      email: clean.email,
      altEmail: null,
      school: clean.school,
      phone: clean.phone,
      birthDate: clean.birthDate,
      age: clean.age,
      role: clean.role,
      termsAcceptedAt: now,
      createdAt: now,
      createdBy: req.admin.uid,
      provider: "password",
    };
    await rtdb().ref(`users/${record.uid}`).set(profile);
    return res.status(201).json({ ok: true, user: publicProfile(record.uid, profile) });
  } catch (err) {
    console.error("POST /api/admin/users failed:", err?.code || err?.message || err);
    return res.status(500).json({ ok: false, error: "Could not create the user." });
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

// ---- Seed-pass Verify tab in /admin ----
// POST /api/admin/seedpass/verify { code } -> membership check: profile +
// every event the member is registered in. Read-only; nothing is written.
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
    // 2) Fallback — sweep users for a stored code (also repairs the index,
    // carrying the owner's name+email so it stays self-describing).
    if (!uid) {
      const usersSnap = await rtdb().ref("users").get();
      const users = usersSnap.val() || {};
      for (const [id, p] of Object.entries(users)) {
        if (String(p?.seedPassCode || "").trim().toUpperCase() === code) {
          uid = id;
          try {
            await rtdb().ref(`seedPassIndex/${code}`).set({
              uid: id,
              fullName: String(p?.fullName || p?.name || ""),
              email: String(p?.email || "").toLowerCase(),
              updatedAt: new Date().toISOString(),
            });
          } catch { /* index repair is best-effort */ }
          break;
        }
      }
    }
    if (!uid) {
      console.warn(`[seedpass] verify miss: ${code} — not in seedPassIndex nor any users/*.`);
      return res.status(404).json({
        ok: false,
        error: `No member found for ${code} — this code does not belong to any member.`,
      });
    }
    const codeNow = await ensureSeedPassCode(uid);
    const profSnap = await rtdb().ref(`users/${uid}`).get();
    const profile = profSnap.val();
    if (!profile) return res.status(404).json({ ok: false, error: `No member found for ${code}.` });
    // Every event this member is registered in (individual + team rosters).
    // null = lookup failed (eventsError explains); the membership answer itself
    // still succeeds either way.
    const events = await memberRegisteredEvents(uid);
    return res.json({
      ok: true,
      code: codeNow || code,
      member: { ...publicProfile(uid, profile), seedPassCode: codeNow || code },
      events: Array.isArray(events) ? events : null,
      eventsError: Array.isArray(events) ? null : "Registrations could not be loaded — try again.",
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

// ---- Club future plans (Future Plans tab in /admin, admin-only) ----
// Private crew todos: what to build / host / buy next. Visible only to
// assigned admins — the whole router already sits behind requireAdmin, so
// members can never list, create, edit or delete these.
//
// Storage (Realtime Database):
//   clubPlans/{planId} = { title, details, status, priority, dueDate,
//                          createdAt, updatedAt, createdBy, createdByName }
// Statuses: todo | in-progress | done. Priorities: low | medium | high.

const PLAN_STATUSES = ["todo", "in-progress", "done"];
const PLAN_PRIORITIES = ["low", "medium", "high"];

function validatePlan(body) {
  const errors = {};
  const title = String(body?.title ?? "").trim();
  const details = String(body?.details ?? "").trim();
  const status = String(body?.status ?? "todo").trim();
  const priority = String(body?.priority ?? "medium").trim();
  const dueDate = String(body?.dueDate ?? "").trim();
  if (title.length < 3) errors.title = "Give the plan a title (min 3 characters).";
  else if (title.length > 120) errors.title = "Title is too long (max 120).";
  if (details.length > 2000) errors.details = "Details are too long (max 2000).";
  if (!PLAN_STATUSES.includes(status)) errors.status = "Status must be todo, in-progress or done.";
  if (!PLAN_PRIORITIES.includes(priority)) errors.priority = "Priority must be low, medium or high.";
  if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) errors.dueDate = "Due date must be YYYY-MM-DD.";
  return {
    errors,
    clean: {
      title,
      details,
      status: PLAN_STATUSES.includes(status) ? status : "todo",
      priority: PLAN_PRIORITIES.includes(priority) ? priority : "medium",
      dueDate: dueDate || null,
    },
  };
}

function publicPlan(id, p) {
  if (!p) return null;
  return {
    id,
    title: p.title || "",
    details: p.details || "",
    status: PLAN_STATUSES.includes(p.status) ? p.status : "todo",
    priority: PLAN_PRIORITIES.includes(p.priority) ? p.priority : "medium",
    dueDate: p.dueDate || null,
    createdAt: p.createdAt || null,
    updatedAt: p.updatedAt || null,
    createdBy: p.createdBy || null,
    createdByName: p.createdByName || null,
  };
}

// GET /api/admin/plans — every future plan, newest first.
router.get("/plans", async (_req, res) => {
  try {
    const snap = await rtdb().ref("clubPlans").get();
    const val = snap.val() || {};
    const plans = Object.entries(val).map(([id, p]) => publicPlan(id, p || {}));
    plans.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    return res.json({ ok: true, plans });
  } catch (err) {
    console.error("GET /api/admin/plans failed:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Could not load future plans." });
  }
});

// POST /api/admin/plans — create a future-plan todo.
router.post("/plans", async (req, res) => {
  const { errors, clean } = validatePlan(req.body);
  if (Object.keys(errors).length > 0) return res.status(400).json({ ok: false, errors });
  try {
    let creatorName = null;
    try {
      const prof = (await rtdb().ref(`users/${req.admin.uid}`).get()).val() || null;
      creatorName = prof?.fullName || prof?.name || null;
    } catch {
      creatorName = null;
    }
    const now = new Date().toISOString();
    const doc = {
      ...clean,
      createdAt: now,
      updatedAt: now,
      createdBy: req.admin.uid,
      createdByName: creatorName,
    };
    const ref = rtdb().ref("clubPlans").push();
    await ref.set(doc);
    return res.status(201).json({ ok: true, plan: publicPlan(ref.key, doc) });
  } catch (err) {
    console.error("POST /api/admin/plans failed:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Could not create the plan." });
  }
});

// PUT /api/admin/plans/:id — update title / details / status / priority / dueDate.
router.put("/plans/:id", async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!id) return res.status(400).json({ ok: false, error: "Missing plan id." });
  const { errors, clean } = validatePlan(req.body);
  if (Object.keys(errors).length > 0) return res.status(400).json({ ok: false, errors });
  try {
    const ref = rtdb().ref(`clubPlans/${id}`);
    const snap = await ref.get();
    if (!snap.exists()) return res.status(404).json({ ok: false, error: "That plan no longer exists." });
    const patch = { ...clean, updatedAt: new Date().toISOString() };
    await ref.update(patch);
    const next = (await ref.get()).val() || {};
    return res.json({ ok: true, plan: publicPlan(id, next) });
  } catch (err) {
    console.error("PUT /api/admin/plans/:id failed:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Could not update the plan." });
  }
});

// DELETE /api/admin/plans/:id — remove a future-plan todo.
router.delete("/plans/:id", async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!id) return res.status(400).json({ ok: false, error: "Missing plan id." });
  try {
    const ref = rtdb().ref(`clubPlans/${id}`);
    const snap = await ref.get();
    if (!snap.exists()) return res.status(404).json({ ok: false, error: "That plan no longer exists." });
    await ref.remove();
    return res.json({ ok: true, id });
  } catch (err) {
    console.error("DELETE /api/admin/plans/:id failed:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Could not delete the plan." });
  }
});

export default router;
