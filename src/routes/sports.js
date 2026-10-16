// Sports system — events, teams, captain-approved joining, auto-lock.
//
//   Public : GET /api/sports/meta, GET /api/sport-events
//   Admin  : POST/PUT/DELETE /api/sport-events[/:id]
//   Members: GET /api/teams?eventId&sportId, POST /api/teams (create, self=captain)
//            POST /api/teams/:id/request (ask captain), GET my teams/requests,
//            captain approve/reject, leave, delete.
//
// Storage (Realtime Database):
//   sportEvents/{id}            event shell (admin-made)
//   teams/{id}                  { eventId, sportId, name, captainUid, members:{uid:{...}}, locked }
//   teamRequests/{teamId}/{uid} { name, status: pending|approved|rejected }

import { Router } from "express";
import { auth, rtdb, isFirebaseReady } from "../firebase.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireAdmin } from "../middleware/requireAdmin.js";

const router = Router();

// Predefined roster rules per sport: min players to be valid, max roster
// size (team LOCKS the moment it fills), plus subs on the side.
export const SPORTS_META = {
  volleyball: { id: "volleyball", name: "Volleyball", min: 6, max: 10, subs: 2, format: "6v6 · Best of 3" },
  football: { id: "football", name: "Football", min: 7, max: 12, subs: 3, format: "7v7 turf · 2×15 min" },
  badminton: { id: "badminton", name: "Badminton", min: 1, max: 2, subs: 0, format: "Singles + Doubles" },
  cricket: { id: "cricket", name: "Cricket", min: 8, max: 10, subs: 2, format: "8-a-side · tennis ball" },
  basketball: { id: "basketball", name: "Basketball", min: 5, max: 10, subs: 3, format: "5v5 · 4×8 min" },
  khokho: { id: "khokho", name: "Kho Kho", min: 9, max: 12, subs: 3, format: "9 on mat + 3 subs" },
};

export const EVENT_CATEGORIES = ["League", "Tournament", "Friendly", "Trials", "Practice"];

function notReady(res) {
  return res.status(503).json({ ok: false, error: "Firebase is not configured on the backend yet." });
}

function toList(val) {
  if (!val || typeof val !== "object") return [];
  return Object.entries(val)
    .map(([id, v]) => ({ id, ...(v || {}) }))
    .sort((x, y) => String(y.createdAt || "").localeCompare(String(x.createdAt || "")));
}

async function memberName(uid, fallback) {
  try {
    const snap = await rtdb().ref(`users/${uid}`).get();
    const p = snap.val() || {};
    return p.fullName || p.name || fallback || "Member";
  } catch {
    return fallback || "Member";
  }
}

function teamStatus(team) {
  const count = team.members ? Object.keys(team.members).length : 0;
  if (team.locked || count >= team.maxPlayers) return "locked";
  if (count >= team.minPlayers) return "ready";
  return "forming";
}

// One roster per member per sport per event — enforced on create + request.
async function existingRoster(uid, eventId, sportId) {
  const snap = await rtdb().ref("teams").get();
  const val = snap.val() || {};
  for (const [id, t] of Object.entries(val)) {
    if (t.eventId === eventId && t.sportId === sportId && t.members && t.members[uid]) {
      return { id, ...t };
    }
  }
  return null;
}

async function pendingRequest(uid, eventId, sportId) {
  const snap = await rtdb().ref("teamRequests").get();
  const val = snap.val() || {};
  const teamsSnap = await rtdb().ref("teams").get();
  const teams = teamsSnap.val() || {};
  for (const [teamId, reqs] of Object.entries(val)) {
    const r = reqs && reqs[uid];
    const t = teams[teamId];
    if (r && r.status === "pending" && t && t.eventId === eventId && t.sportId === sportId) {
      return { teamId, ...r };
    }
  }
  return null;
}

// ---------- public ----------

// Predefined sports + roster caps (drives both admin maker and member UI).
router.get("/sports/meta", (_req, res) => {
  return res.json({
    ok: true,
    sports: Object.values(SPORTS_META),
    categories: EVENT_CATEGORIES,
  });
});

// All sport events, newest first. Members pick one, then a sport inside it.
router.get("/sport-events", async (_req, res) => {
  if (!isFirebaseReady()) return notReady(res);
  try {
    const snap = await rtdb().ref("sportEvents").get();
    return res.json({ ok: true, events: toList(snap.val()) });
  } catch (err) {
    console.error("GET /api/sport-events failed:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Could not load events." });
  }
});

// ---------- admin: make/officially launch events ----------

function validateEvent(body) {
  const errors = {};
  const title = String(body?.title ?? "").trim();
  const category = String(body?.category ?? "").trim();
  const description = String(body?.description ?? body?.body ?? "").trim();
  const venue = String(body?.venue ?? "").trim().slice(0, 120);
  const eventDate = String(body?.eventDate ?? body?.date ?? "").trim();
  const sports = Array.isArray(body?.sports) ? body.sports.map((s) => String(s)).filter((s) => SPORTS_META[s]) : [];
  const status = String(body?.status ?? "open").trim();
  if (title.length < 3) errors.title = "Give the event a title (min 3 characters).";
  if (title.length > 120) errors.title = "Title must be 120 characters or fewer.";
  if (!EVENT_CATEGORIES.includes(category)) errors.category = `Pick a category: ${EVENT_CATEGORIES.join(", ")}.`;
  if (description.length > 2000) errors.description = "Description must be 2000 characters or fewer.";
  if (sports.length === 0) errors.sports = "Select at least one sport for this event.";
  if (status !== "open" && status !== "closed") errors.status = "Status must be open or closed.";
  return { errors, clean: { title, category, description, venue: venue || null, eventDate: eventDate || null, sports, status } };
}

router.post("/sport-events", requireAdmin, async (req, res) => {
  const { errors, clean } = validateEvent(req.body);
  if (Object.keys(errors).length > 0) return res.status(400).json({ ok: false, errors });
  try {
    const now = new Date().toISOString();
    const ref = rtdb().ref("sportEvents").push();
    const event = { ...clean, createdBy: req.admin.uid, createdAt: now, updatedAt: now };
    await ref.set(event);
    return res.status(201).json({ ok: true, event: { id: ref.key, ...event } });
  } catch (err) {
    console.error("POST /api/sport-events failed:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Could not create the event." });
  }
});

router.put("/sport-events/:id", requireAdmin, async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!id || /[.#$[\]]/.test(id)) return res.status(400).json({ ok: false, error: "Invalid event id." });
  const { errors, clean } = validateEvent(req.body);
  if (Object.keys(errors).length > 0) return res.status(400).json({ ok: false, errors });
  try {
    const ref = rtdb().ref(`sportEvents/${id}`);
    const snap = await ref.get();
    if (!snap.exists()) return res.status(404).json({ ok: false, error: "Event not found." });
    const prev = snap.val() || {};
    const updated = { ...prev, ...clean, updatedAt: new Date().toISOString() };
    await ref.set(updated);
    return res.json({ ok: true, event: { id, ...updated } });
  } catch (err) {
    console.error("PUT /api/sport-events/:id failed:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Could not update the event." });
  }
});

router.delete("/sport-events/:id", requireAdmin, async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!id || /[.#$[\]]/.test(id)) return res.status(400).json({ ok: false, error: "Invalid event id." });
  try {
    const ref = rtdb().ref(`sportEvents/${id}`);
    if (!(await ref.get()).exists()) return res.status(404).json({ ok: false, error: "Event not found." });
    // Cascade: remove its teams + their join requests.
    const teamsSnap = await rtdb().ref("teams").get();
    const teams = teamsSnap.val() || {};
    for (const [teamId, t] of Object.entries(teams)) {
      if (t.eventId === id) {
        await rtdb().ref(`teams/${teamId}`).remove();
        await rtdb().ref(`teamRequests/${teamId}`).remove();
      }
    }
    await ref.remove();
    return res.json({ ok: true, id });
  } catch (err) {
    console.error("DELETE /api/sport-events/:id failed:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Could not delete the event." });
  }
});

// ---------- members: teams ----------

function publicTeam(id, t) {
  const members = t.members || {};
  const count = Object.keys(members).length;
  return {
    id,
    eventId: t.eventId,
    sportId: t.sportId,
    name: t.name,
    captainUid: t.captainUid,
    captainName: t.captainName,
    members: Object.entries(members).map(([uid, m]) => ({ uid, name: m.name, joinedAt: m.joinedAt })),
    count,
    minPlayers: t.minPlayers,
    maxPlayers: t.maxPlayers,
    subs: t.subs,
    status: teamStatus({ ...t, members }),
    locked: teamStatus({ ...t, members }) === "locked",
    createdAt: t.createdAt,
  };
}

// Teams of one event (+ optional sport filter). Members only.
router.get("/teams", requireAuth, async (req, res) => {
  if (!isFirebaseReady()) return notReady(res);
  const eventId = String(req.query.eventId || "").trim();
  const sportId = String(req.query.sportId || "").trim();
  if (!eventId) return res.status(400).json({ ok: false, error: "eventId is required." });
  try {
    const snap = await rtdb().ref("teams").get();
    const val = snap.val() || {};
    const teams = Object.entries(val)
      .filter(([, t]) => t.eventId === eventId && (!sportId || t.sportId === sportId))
      .map(([id, t]) => publicTeam(id, t));
    return res.json({ ok: true, teams });
  } catch (err) {
    console.error("GET /api/teams failed:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Could not load teams." });
  }
});

// My rosters + my pending requests (drives "my teams" badges).
router.get("/my-teams", requireAuth, async (req, res) => {
  try {
    const [teamsSnap, reqSnap] = await Promise.all([
      rtdb().ref("teams").get(),
      rtdb().ref("teamRequests").get(),
    ]);
    const teams = teamsSnap.val() || {};
    const reqs = reqSnap.val() || {};
    const mine = [];
    const pending = [];
    for (const [id, t] of Object.entries(teams)) {
      if (t.members && t.members[req.member.uid]) mine.push(publicTeam(id, t));
    }
    for (const [teamId, byUser] of Object.entries(reqs)) {
      const r = byUser && byUser[req.member.uid];
      if (r && r.status === "pending" && teams[teamId]) {
        pending.push({ teamId, teamName: teams[teamId].name, eventId: teams[teamId].eventId, sportId: teams[teamId].sportId, requestedAt: r.requestedAt });
      }
    }
    return res.json({ ok: true, teams: mine, pending });
  } catch (err) {
    console.error("GET /api/my-teams failed:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Could not load your teams." });
  }
});

// Create my own team — I become captain + first member.
router.post("/teams", requireAuth, async (req, res) => {
  const eventId = String(req.body?.eventId || "").trim();
  const sportId = String(req.body?.sportId || "").trim();
  const name = String(req.body?.name || "").trim();
  const errors = {};
  if (!eventId) errors.eventId = "Pick an event.";
  if (!SPORTS_META[sportId]) errors.sportId = "Pick a valid sport.";
  if (name.length < 2) errors.name = "Give your team a name (min 2 characters).";
  if (name.length > 60) errors.name = "Team name must be 60 characters or fewer.";
  if (Object.keys(errors).length > 0) return res.status(400).json({ ok: false, errors });
  try {
    const evSnap = await rtdb().ref(`sportEvents/${eventId}`).get();
    const ev = evSnap.val();
    if (!ev) return res.status(404).json({ ok: false, error: "Event not found." });
    if (ev.status !== "open") return res.status(400).json({ ok: false, error: "This event is closed for new teams." });
    if (!Array.isArray(ev.sports) || !ev.sports.includes(sportId)) {
      return res.status(400).json({ ok: false, error: "This sport is not part of the event." });
    }
    if (await existingRoster(req.member.uid, eventId, sportId)) {
      return res.status(400).json({ ok: false, error: "You already have a team in this sport for this event." });
    }
    if (await pendingRequest(req.member.uid, eventId, sportId)) {
      return res.status(400).json({ ok: false, error: "You already asked to join a team here — wait for the captain." });
    }
    const meta = SPORTS_META[sportId];
    const now = new Date().toISOString();
    const captainName = await memberName(req.member.uid, req.member.name);
    const ref = rtdb().ref("teams").push();
    const team = {
      eventId,
      sportId,
      name,
      captainUid: req.member.uid,
      captainName,
      members: { [req.member.uid]: { name: captainName, joinedAt: now } },
      minPlayers: meta.min,
      maxPlayers: meta.max,
      subs: meta.subs,
      createdAt: now,
    };
    // Solo-sport edge (badminton singles): a 1-max roster fills instantly.
    team.locked = Object.keys(team.members).length >= meta.max;
    await ref.set(team);
    return res.status(201).json({ ok: true, team: publicTeam(ref.key, team) });
  } catch (err) {
    console.error("POST /api/teams failed:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Could not create the team." });
  }
});

// Ask the captain to let me in.
router.post("/teams/:id/request", requireAuth, async (req, res) => {
  const id = String(req.params.id || "").trim();
  try {
    const snap = await rtdb().ref(`teams/${id}`).get();
    const t = snap.val();
    if (!t) return res.status(404).json({ ok: false, error: "Team not found." });
    const pub = publicTeam(id, t);
    if (pub.locked) return res.status(400).json({ ok: false, error: "This team is locked — roster is full." });
    if (t.members && t.members[req.member.uid]) {
      return res.status(400).json({ ok: false, error: "You are already in this team." });
    }
    if (await existingRoster(req.member.uid, t.eventId, t.sportId)) {
      return res.status(400).json({ ok: false, error: "You already have a team in this sport for this event." });
    }
    const existing = await rtdb().ref(`teamRequests/${id}/${req.member.uid}`).get();
    if (existing.val() && existing.val().status === "pending") {
      return res.status(400).json({ ok: false, error: "Request already sent — waiting on the captain." });
    }
    const name = await memberName(req.member.uid, req.member.name);
    await rtdb().ref(`teamRequests/${id}/${req.member.uid}`).set({
      name,
      status: "pending",
      requestedAt: new Date().toISOString(),
    });
    return res.status(201).json({ ok: true, captain: t.captainName });
  } catch (err) {
    console.error("POST /api/teams/:id/request failed:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Could not send the request." });
  }
});

// Pending requests for my team — captain (or admin) only.
router.get("/teams/:id/requests", requireAuth, async (req, res) => {
  const id = String(req.params.id || "").trim();
  try {
    const snap = await rtdb().ref(`teams/${id}`).get();
    const t = snap.val();
    if (!t) return res.status(404).json({ ok: false, error: "Team not found." });
    let isAdmin = false;
    try {
      const me = await rtdb().ref(`users/${req.member.uid}`).get();
      isAdmin = me.val() && me.val().role === "admin";
    } catch { /* ignore */ }
    if (t.captainUid !== req.member.uid && !isAdmin) {
      return res.status(403).json({ ok: false, error: "Only the captain can see requests." });
    }
    const rsnap = await rtdb().ref(`teamRequests/${id}`).get();
    const val = rsnap.val() || {};
    const requests = Object.entries(val)
      .filter(([, r]) => r.status === "pending")
      .map(([uid, r]) => ({ uid, name: r.name, requestedAt: r.requestedAt }));
    return res.json({ ok: true, requests });
  } catch (err) {
    console.error("GET /api/teams/:id/requests failed:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Could not load requests." });
  }
});

// Captain approves/rejects. Approving a full house LOCKS the team.
router.post("/teams/:id/requests/:uid", requireAuth, async (req, res) => {
  const id = String(req.params.id || "").trim();
  const targetUid = String(req.params.uid || "").trim();
  const action = String(req.body?.action || "").trim();
  if (action !== "approve" && action !== "reject") {
    return res.status(400).json({ ok: false, error: "Action must be approve or reject." });
  }
  try {
    const snap = await rtdb().ref(`teams/${id}`).get();
    const t = snap.val();
    if (!t) return res.status(404).json({ ok: false, error: "Team not found." });
    let isAdmin = false;
    try {
      const me = await rtdb().ref(`users/${req.member.uid}`).get();
      isAdmin = me.val() && me.val().role === "admin";
    } catch { /* ignore */ }
    if (t.captainUid !== req.member.uid && !isAdmin) {
      return res.status(403).json({ ok: false, error: "Only the captain decides who joins." });
    }
    const rsnap = await rtdb().ref(`teamRequests/${id}/${targetUid}`).get();
    const r = rsnap.val();
    if (!r || r.status !== "pending") {
      return res.status(404).json({ ok: false, error: "Request not found or already decided." });
    }
    if (action === "reject") {
      await rtdb().ref(`teamRequests/${id}/${targetUid}`).update({ status: "rejected", decidedAt: new Date().toISOString() });
      return res.json({ ok: true, action: "rejected" });
    }
    // Approve: re-check everything at decision time.
    const fresh = (await rtdb().ref(`teams/${id}`).get()).val();
    const count = fresh.members ? Object.keys(fresh.members).length : 0;
    if (count >= fresh.maxPlayers) {
      await rtdb().ref(`teams/${id}`).update({ locked: true });
      return res.status(400).json({ ok: false, error: "Team is already locked — roster is full." });
    }
    if (await existingRoster(targetUid, fresh.eventId, fresh.sportId)) {
      await rtdb().ref(`teamRequests/${id}/${targetUid}`).update({ status: "rejected", decidedAt: new Date().toISOString() });
      return res.status(400).json({ ok: false, error: "They joined another team meanwhile." });
    }
    const name = await memberName(targetUid, r.name);
    await rtdb().ref(`teams/${id}/members/${targetUid}`).set({ name, joinedAt: new Date().toISOString() });
    await rtdb().ref(`teamRequests/${id}/${targetUid}`).update({ status: "approved", decidedAt: new Date().toISOString() });
    const after = (await rtdb().ref(`teams/${id}`).get()).val();
    const locked = Object.keys(after.members || {}).length >= after.maxPlayers;
    if (locked) await rtdb().ref(`teams/${id}`).update({ locked: true });
    return res.json({ ok: true, action: "approved", locked });
  } catch (err) {
    console.error("POST /api/teams/:id/requests/:uid failed:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Could not decide the request." });
  }
});

// Leave a team (members only — the captain must delete the team instead).
router.delete("/teams/:id/leave", requireAuth, async (req, res) => {
  const id = String(req.params.id || "").trim();
  try {
    const snap = await rtdb().ref(`teams/${id}`).get();
    const t = snap.val();
    if (!t) return res.status(404).json({ ok: false, error: "Team not found." });
    if (t.captainUid === req.member.uid) {
      return res.status(400).json({ ok: false, error: "Captains can't walk out — delete the team instead." });
    }
    if (!t.members || !t.members[req.member.uid]) {
      return res.status(400).json({ ok: false, error: "You are not in this team." });
    }
    await rtdb().ref(`teams/${id}/members/${req.member.uid}`).remove();
    const after = (await rtdb().ref(`teams/${id}`).get()).val() || {};
    const count = Object.keys(after.members || {}).length;
    if (after.locked && count < after.maxPlayers) {
      await rtdb().ref(`teams/${id}`).update({ locked: false });
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/teams/:id/leave failed:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Could not leave the team." });
  }
});

// Delete a team — captain or admin. Its requests go with it.
router.delete("/teams/:id", requireAuth, async (req, res) => {
  const id = String(req.params.id || "").trim();
  try {
    const snap = await rtdb().ref(`teams/${id}`).get();
    const t = snap.val();
    if (!t) return res.status(404).json({ ok: false, error: "Team not found." });
    let isAdmin = false;
    try {
      const me = await rtdb().ref(`users/${req.member.uid}`).get();
      isAdmin = me.val() && me.val().role === "admin";
    } catch { /* ignore */ }
    if (t.captainUid !== req.member.uid && !isAdmin) {
      return res.status(403).json({ ok: false, error: "Only the captain (or an admin) can delete the team." });
    }
    await rtdb().ref(`teams/${id}`).remove();
    await rtdb().ref(`teamRequests/${id}`).remove();
    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/teams/:id failed:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Could not delete the team." });
  }
});

export default router;
