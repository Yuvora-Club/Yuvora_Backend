// Announcements — the club notice board.
// Public:  GET /api/announcements -> { announcements: [...] } (newest first)
// Admin:   POST /api/announcements, PUT /api/announcements/:id,
//          DELETE /api/announcements/:id (requireAdmin middleware).
// Storage: Realtime Database `announcements/{pushId}` so the member
// dashboard (/dashboard) can render whatever the admin posts.

import { Router } from "express";
import { rtdb, isFirebaseReady } from "../firebase.js";
import { requireAdmin } from "../middleware/requireAdmin.js";

const router = Router();

function notReady(res) {
  return res.status(503).json({
    ok: false,
    error: "Firebase is not configured on the backend yet. Fill Backend/.env first.",
  });
}

function toList(val) {
  if (!val || typeof val !== "object") return [];
  return Object.entries(val)
    .map(([id, a]) => ({ id, ...(a || {}) }))
    .sort((x, y) => String(y.createdAt || "").localeCompare(String(x.createdAt || "")));
}

function validate(body) {
  const errors = {};
  const title = String(body?.title ?? "").trim();
  const text = String(body?.body ?? body?.text ?? "").trim();
  const tag = String(body?.tag ?? "").trim().slice(0, 40);
  if (title.length < 3) errors.title = "Give the announcement a short title (min 3 characters).";
  if (title.length > 120) errors.title = "Title must be 120 characters or fewer.";
  if (text.length < 3) errors.body = "Write a few words for the announcement body.";
  if (text.length > 2000) errors.body = "Body must be 2000 characters or fewer.";
  return { errors, clean: { title, body: text, tag: tag || null } };
}

// Public notice board — rendered on the member dashboard.
router.get("/", async (_req, res) => {
  if (!isFirebaseReady()) return notReady(res);
  try {
    const snap = await rtdb().ref("announcements").get();
    return res.json({ ok: true, announcements: toList(snap.val()) });
  } catch (err) {
    console.error("GET /api/announcements failed:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Could not load announcements." });
  }
});

// Admin: post a new announcement -> appears on /dashboard for members.
router.post("/", requireAdmin, async (req, res) => {
  const { errors, clean } = validate(req.body);
  if (Object.keys(errors).length > 0) return res.status(400).json({ ok: false, errors });
  try {
    const now = new Date().toISOString();
    const ref = rtdb().ref("announcements").push();
    const announcement = {
      ...clean,
      authorUid: req.admin.uid,
      createdAt: now,
      updatedAt: now,
    };
    await ref.set(announcement);
    return res.status(201).json({ ok: true, announcement: { id: ref.key, ...announcement } });
  } catch (err) {
    console.error("POST /api/announcements failed:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Could not post the announcement." });
  }
});

// Admin: edit title / body / tag.
router.put("/:id", requireAdmin, async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!id || /[.#$[\]]/.test(id)) return res.status(400).json({ ok: false, error: "Invalid announcement id." });
  const { errors, clean } = validate(req.body);
  if (Object.keys(errors).length > 0) return res.status(400).json({ ok: false, errors });
  try {
    const ref = rtdb().ref(`announcements/${id}`);
    const snap = await ref.get();
    if (!snap.exists()) return res.status(404).json({ ok: false, error: "Announcement not found." });
    const prev = snap.val() || {};
    const updated = { ...prev, ...clean, updatedAt: new Date().toISOString() };
    await ref.update({ title: updated.title, body: updated.body, tag: updated.tag, updatedAt: updated.updatedAt });
    return res.json({ ok: true, announcement: { id, ...updated } });
  } catch (err) {
    console.error("PUT /api/announcements/:id failed:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Could not update the announcement." });
  }
});

// Admin: delete.
router.delete("/:id", requireAdmin, async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!id || /[.#$[\]]/.test(id)) return res.status(400).json({ ok: false, error: "Invalid announcement id." });
  try {
    const ref = rtdb().ref(`announcements/${id}`);
    const snap = await ref.get();
    if (!snap.exists()) return res.status(404).json({ ok: false, error: "Announcement not found." });
    await ref.remove();
    return res.json({ ok: true, id });
  } catch (err) {
    console.error("DELETE /api/announcements/:id failed:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Could not delete the announcement." });
  }
});

export default router;
