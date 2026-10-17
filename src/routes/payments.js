// Team entry-fee payments — MANUAL UPI with unique-paise reconciliation.
//
// The browser is never trusted for money: the fee is computed here from the
// event's admin-set fee, the slot cap and paise allocation are enforced with
// atomic RTDB transactions, and a payment only counts once a pay-admin
// Confirms it. Payments stay dormant (no UPI link / QR) until a real UPI_ID
// is set in the environment.
//
// Member (captain) routes — require the member ID token:
//   GET  /api/pay/config                 safe public bits for the UI
//   GET  /api/teams/:teamId/payment      fee preview + this team's active order
//   POST /api/teams/:teamId/order        create the order (captain only)
//   GET  /api/pay/orders/:orderId        load one order (its captain / an admin)
//   POST /api/pay/orders/:orderId/utr    submit the 12-digit UTR (captain only)
//
// Standalone pay-admin dashboard routes — require the ADMIN_PASSWORD_HASH
// session token (middleware/requirePayAdmin.js):
//   POST /api/pay-admin/login
//   POST /api/pay-admin/logout
//   GET  /api/pay-admin/orders?status=
//   POST /api/pay-admin/orders/:orderId/status
//   GET  /api/pay-admin/summary
//   GET  /api/pay-admin/orders.csv
//
// Storage (Realtime Database):
//   paymentOrders/{orderId}            the order record
//   paymentOrdersByTeam/{teamId}       -> orderId (one active order per team)
//   paymentOrdersByUtr/{utr}           -> orderId (UTR uniqueness)
//   paymentPaise/{1..99}               -> orderId (unique-paise allocation)
//   paymentEventCounters/{eventId}/used  occupied slots (Confirmed + active Pending)
//   payAudit/{pushId}                  admin action log

import { Router } from "express";
import crypto from "node:crypto";
import QRCode from "qrcode";
import { rtdb, isFirebaseReady } from "../firebase.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { requirePayAdmin, signPaySession, isPayAdminOpen } from "../middleware/requirePayAdmin.js";
import { SPORTS_META } from "./sports.js";

const router = Router();

const PLACEHOLDER_UPI = "PLACEHOLDER_UPI_ID";

function toInt(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

const UPI_ID = String(process.env.UPI_ID || PLACEHOLDER_UPI).trim();
const PAYEE_NAME = String(process.env.PAYEE_NAME || "Yuvora").trim();
const ENTRY_FEE_PER_TEAM = Math.max(0, toInt(process.env.ENTRY_FEE_PER_TEAM, 1500));
const FEE_MODE = String(process.env.FEE_MODE || "team").trim() === "player" ? "player" : "team";
const FEE_PER_PLAYER = Math.max(0, toInt(process.env.FEE_PER_PLAYER, 0));
const MAX_TEAMS = Math.max(0, toInt(process.env.MAX_TEAMS, 0));
const ORDER_EXPIRY_HOURS = Math.max(1, toInt(process.env.ORDER_EXPIRY_HOURS, 24));
const CAPTCHA_SITE_KEY = String(process.env.CAPTCHA_SITE_KEY || "").trim();
const CAPTCHA_SECRET = String(process.env.CAPTCHA_SECRET || "").trim();
const REFUND_NOTE = String(
  process.env.REFUND_NOTE || "No refunds after the registration deadline."
).trim();

const ORDER_STATUSES = ["Pending", "Confirmed", "Rejected", "Expired", "NeedsRefund", "Refunded"];
// Statuses that occupy a slot while live.
const LIVE_STATUSES = ["Pending", "Confirmed", "NeedsRefund"];

function paymentsOpen() {
  return !!UPI_ID && UPI_ID !== PLACEHOLDER_UPI;
}

function captchaEnabled() {
  return !!CAPTCHA_SECRET && !CAPTCHA_SECRET.startsWith("PLACEHOLDER");
}

function notReady(res) {
  return res.status(503).json({ ok: false, error: "Firebase is not configured on the backend yet." });
}

function safeId(raw) {
  const id = String(raw || "").trim();
  if (!id || /[.#$/[\]]/.test(id)) return null;
  return id;
}

// ---------- tiny in-memory rate limiter (single Render instance) ----------
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= max) {
    buckets.set(key, hits);
    return false;
  }
  hits.push(now);
  buckets.set(key, hits);
  return true;
}

function clientIp(req) {
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return fwd || req.ip || "unknown";
}

// ---------- fee resolution ----------
// A fee is only taken from a field when it actually holds a number: blank,
// null and junk fall through to the next source instead of becoming ₹0.
function feeFrom(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function resolveBaseFee(event, sportId, playerCount) {
  const fees = (event && event.sportFees) || {};
  let fee = feeFrom(fees[sportId]);
  if (fee === null) fee = feeFrom(event && event.entryFee);
  if (fee === null) {
    fee = FEE_MODE === "player" ? FEE_PER_PLAYER * Math.max(1, playerCount) : ENTRY_FEE_PER_TEAM;
  }
  return Math.max(0, Math.round(fee));
}

function maxTeamsFor(event) {
  const n = Number(event && event.maxTeams);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : MAX_TEAMS;
}

// ---------- atomic helpers ----------
async function reserveSlot(eventId, maxTeams) {
  if (!maxTeams || maxTeams <= 0) return { ok: true, reserved: false };
  const res = await rtdb()
    .ref(`paymentEventCounters/${eventId}/used`)
    .transaction((cur) => {
      const used = typeof cur === "number" ? cur : 0;
      if (used >= maxTeams) return; // abort
      return used + 1;
    });
  return { ok: res.committed === true, reserved: res.committed === true };
}

async function releaseSlot(eventId) {
  try {
    await rtdb()
      .ref(`paymentEventCounters/${eventId}/used`)
      .transaction((cur) => {
        const used = typeof cur === "number" ? cur : 0;
        return used > 0 ? used - 1 : 0;
      });
  } catch {
    /* best-effort */
  }
}

async function allocatePaise(orderId) {
  const start = crypto.randomInt(1, 100);
  for (let i = 0; i < 99; i++) {
    const paise = ((start + i - 1) % 99) + 1;
    const ref = rtdb().ref(`paymentPaise/${paise}`);
    const res = await ref.transaction((cur) => (cur === null ? orderId : undefined));
    if (res.committed && res.snapshot.val() === orderId) return paise;
  }
  return null;
}

async function releasePaise(paise, orderId) {
  if (!paise) return;
  try {
    await rtdb()
      .ref(`paymentPaise/${paise}`)
      .transaction((cur) => (cur === orderId ? null : undefined));
  } catch {
    /* best-effort */
  }
}

async function claimUtr(utr, orderId) {
  const res = await rtdb()
    .ref(`paymentOrdersByUtr/${utr}`)
    .transaction((cur) => (cur === null ? orderId : undefined));
  return res.committed === true && res.snapshot.val() === orderId;
}

// ---------- UPI link + QR ----------
function buildUpiLink(amount, orderRef) {
  const params = new URLSearchParams({
    pa: UPI_ID,
    pn: PAYEE_NAME,
    am: Number(amount).toFixed(2),
    cu: "INR",
    tn: orderRef,
  });
  return `upi://pay?${params.toString()}`;
}

async function linksFor(order) {
  if (!paymentsOpen() || order.status !== "Pending") return { upiLink: null, qrDataUrl: null };
  const link = buildUpiLink(order.expectedAmount, order.orderRef);
  let qrDataUrl = null;
  try {
    qrDataUrl = await QRCode.toDataURL(link, { margin: 1, width: 260 });
  } catch {
    qrDataUrl = null;
  }
  return { upiLink: link, qrDataUrl };
}

// ---------- email (log-stub until a provider is configured) ----------
async function notifyCaptain(order, subject, body) {
  // No mail provider is wired yet — log so the crew can see what WOULD send.
  console.log(`[pay-mail] to=${order.captainEmail || "(none)"} subject="${subject}" :: ${body}`);
}

// ---------- shapes ----------
function publicOrder(order) {
  if (!order) return null;
  return {
    id: order.id,
    orderRef: order.orderRef,
    status: order.status,
    eventId: order.eventId,
    sportId: order.sportId,
    teamId: order.teamId,
    teamName: order.teamName,
    captainName: order.captainName,
    playerCount: order.playerCount,
    baseAmount: order.baseAmount,
    uniquePaise: order.uniquePaise,
    expectedAmount: order.expectedAmount,
    utr: order.utr || null,
    createdAt: order.createdAt,
    expiresAt: order.expiresAt,
    confirmedAt: order.confirmedAt || null,
    notes: order.notes || null,
  };
}

function adminOrder(order) {
  return {
    ...publicOrder(order),
    captainUid: order.captainUid,
    captainPhone: order.captainPhone || "",
    captainEmail: order.captainEmail || "",
    slotHeld: order.slotHeld === true,
    paiseHeld: order.paiseHeld === true,
    confirmedBy: order.confirmedBy || null,
    updatedAt: order.updatedAt || null,
  };
}

// Human labels for the dashboard / CSV (event titles + sport names).
function sportLabel(id) {
  return (SPORTS_META[id] && SPORTS_META[id].name) || id || "";
}

async function eventTitles() {
  try {
    const snap = await rtdb().ref("sportEvents").get();
    const val = snap.val() || {};
    const map = {};
    for (const [id, ev] of Object.entries(val)) if (ev) map[id] = ev.title || id;
    return map;
  } catch {
    return {};
  }
}

async function readOrder(orderId) {
  const id = safeId(orderId);
  if (!id) return null;
  const snap = await rtdb().ref(`paymentOrders/${id}`).get();
  const val = snap.val();
  return val ? { id, ...val } : null;
}

// Expire a single order in place if its window has passed. Returns the order.
async function refreshExpiry(order) {
  if (!order || order.status !== "Pending") return order;
  const t = Date.parse(order.expiresAt || "");
  if (!Number.isFinite(t) || t > Date.now()) return order;
  if (order.slotHeld) await releaseSlot(order.eventId);
  if (order.paiseHeld) await releasePaise(order.uniquePaise, order.id);
  const patch = {
    status: "Expired",
    slotHeld: false,
    paiseHeld: false,
    updatedAt: new Date().toISOString(),
  };
  await rtdb().ref(`paymentOrders/${order.id}`).update(patch);
  if (order.teamId) {
    const idx = (await rtdb().ref(`paymentOrdersByTeam/${order.teamId}`).get()).val();
    if (idx === order.id) await rtdb().ref(`paymentOrdersByTeam/${order.teamId}`).remove();
  }
  return { ...order, ...patch };
}

async function sweepExpired() {
  try {
    const snap = await rtdb().ref("paymentOrders").get();
    const val = snap.val() || {};
    const now = Date.now();
    for (const [id, o] of Object.entries(val)) {
      if (!o || o.status !== "Pending") continue;
      const t = Date.parse(o.expiresAt || "");
      if (Number.isFinite(t) && t <= now) await refreshExpiry({ id, ...o });
    }
  } catch {
    /* best-effort */
  }
}

// ---------- auth for a team (captain / admin) ----------
async function isAdminUid(uid) {
  try {
    const snap = await rtdb().ref(`users/${uid}`).get();
    return (snap.val() || {}).role === "admin";
  } catch {
    return false;
  }
}

async function loadTeam(teamId) {
  const id = safeId(teamId);
  if (!id) return null;
  const snap = await rtdb().ref(`teams/${id}`).get();
  const val = snap.val();
  return val ? { id, ...val } : null;
}

// ================= member (captain) routes =================

router.get("/pay/config", requireAuth, (_req, res) => {
  return res.json({
    ok: true,
    paymentsOpen: paymentsOpen(),
    payeeName: PAYEE_NAME,
    upiId: paymentsOpen() ? UPI_ID : null,
    feeMode: FEE_MODE,
    entryFeePerTeam: ENTRY_FEE_PER_TEAM,
    feePerPlayer: FEE_PER_PLAYER,
    maxTeams: MAX_TEAMS,
    orderExpiryHours: ORDER_EXPIRY_HOURS,
    refundNote: REFUND_NOTE,
    captchaSiteKey: captchaEnabled() ? CAPTCHA_SITE_KEY : null,
  });
});

// Fee preview for a team, plus the team's active order (captain only sees it).
router.get("/teams/:teamId/payment", requireAuth, async (req, res) => {
  if (!isFirebaseReady()) return notReady(res);
  try {
    const team = await loadTeam(req.params.teamId);
    if (!team) return res.status(404).json({ ok: false, error: "Team not found." });
    const evSnap = await rtdb().ref(`sportEvents/${team.eventId}`).get();
    const event = evSnap.val() || {};
    const playerCount = team.members ? Object.keys(team.members).length : 1;
    const baseAmount = resolveBaseFee(event, team.sportId, playerCount);
    const isCaptain = team.captainUid === req.member.uid;

    let order = null;
    if (isCaptain) {
      const idx = (await rtdb().ref(`paymentOrdersByTeam/${team.id}`).get()).val();
      if (idx) order = await readOrder(idx);
      order = await refreshExpiry(order);
    }
    const withLinks = order ? { ...publicOrder(order), ...(await linksFor(order)) } : null;

    return res.json({
      ok: true,
      teamId: team.id,
      eventId: team.eventId,
      eventTitle: event.title || "",
      sportId: team.sportId,
      teamName: team.name,
      playerCount,
      baseAmount,
      paid: team.paid === true,
      paidAt: team.paidAt || null,
      paymentsOpen: paymentsOpen(),
      upiId: paymentsOpen() ? UPI_ID : null,
      payeeName: PAYEE_NAME,
      captchaSiteKey: captchaEnabled() ? CAPTCHA_SITE_KEY : null,
      refundNote: REFUND_NOTE,
      isCaptain,
      order: withLinks,
    });
  } catch (err) {
    console.error("GET /api/teams/:teamId/payment failed:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Could not load the payment." });
  }
});

// Captain creates (or revives) the team's entry-fee order.
router.post("/teams/:teamId/order", requireAuth, async (req, res) => {
  if (!isFirebaseReady()) return notReady(res);
  if (!rateLimit(`order:${clientIp(req)}`, 12, 60_000)) {
    return res.status(429).json({ ok: false, error: "Too many attempts — wait a minute and retry." });
  }
  try {
    const team = await loadTeam(req.params.teamId);
    if (!team) return res.status(404).json({ ok: false, error: "Team not found." });
    if (team.captainUid !== req.member.uid) {
      return res.status(403).json({ ok: false, error: "Only the captain can pay this team's entry fee." });
    }
    if (team.paid === true) {
      return res.status(400).json({ ok: false, error: "This team's entry fee is already marked paid." });
    }

    // Reuse the live order if one exists (idempotent re-submit).
    const idx = (await rtdb().ref(`paymentOrdersByTeam/${team.id}`).get()).val();
    if (idx) {
      const existing = await refreshExpiry(await readOrder(idx));
      if (existing && existing.status === "Pending") {
        return res.status(200).json({
          ok: true,
          order: { ...publicOrder(existing), ...(await linksFor(existing)) },
          reused: true,
        });
      }
      if (existing && existing.status === "Confirmed") {
        return res.status(400).json({ ok: false, error: "This team's fee is already confirmed paid." });
      }
      await rtdb().ref(`paymentOrdersByTeam/${team.id}`).remove();
    }

    // CAPTCHA (skipped while CAPTCHA_SECRET is a placeholder).
    if (captchaEnabled()) {
      const token = String(req.body?.captchaToken || "").trim();
      if (!token) return res.status(400).json({ ok: false, error: "Complete the CAPTCHA and retry." });
      const verified = await verifyTurnstile(token, clientIp(req));
      if (!verified) return res.status(400).json({ ok: false, error: "CAPTCHA check failed — retry." });
    }

    const evSnap = await rtdb().ref(`sportEvents/${team.eventId}`).get();
    const event = evSnap.val() || {};
    const playerCount = team.members ? Object.keys(team.members).length : 1;
    const baseAmount = resolveBaseFee(event, team.sportId, playerCount);
    const maxTeams = maxTeamsFor(event);

    const slot = await reserveSlot(team.eventId, maxTeams);
    if (!slot.ok) {
      return res.status(409).json({ ok: false, error: "This event is full — no more team slots." });
    }

    const orderId = rtdb().ref("paymentOrders").push().key;
    const paise = await allocatePaise(orderId);
    if (paise == null) {
      if (slot.reserved) await releaseSlot(team.eventId);
      return res.status(409).json({ ok: false, error: "Payment amounts are temporarily exhausted — try again shortly." });
    }

    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const profile = (await rtdb().ref(`users/${req.member.uid}`).get()).val() || {};
    const order = {
      orderRef: `YUVORA-ORD-${now.toString(36).toUpperCase()}${crypto.randomInt(100, 999)}`,
      publicToken: crypto.randomBytes(24).toString("base64url"),
      eventId: team.eventId,
      sportId: team.sportId,
      teamId: team.id,
      teamName: team.name,
      captainUid: req.member.uid,
      captainName: team.captainName || profile.fullName || req.member.name || "Captain",
      captainPhone: profile.phone || "",
      captainEmail: profile.email || "",
      playerCount,
      baseAmount,
      uniquePaise: paise,
      expectedAmount: baseAmount + paise / 100,
      status: "Pending",
      utr: null,
      slotHeld: slot.reserved === true,
      paiseHeld: true,
      createdAt: nowIso,
      expiresAt: new Date(now + ORDER_EXPIRY_HOURS * 3_600_000).toISOString(),
      confirmedAt: null,
      confirmedBy: null,
      notes: null,
      updatedAt: nowIso,
    };

    await rtdb().ref(`paymentOrders/${orderId}`).set(order);
    await rtdb().ref(`paymentOrdersByTeam/${team.id}`).set(orderId);

    const saved = { id: orderId, ...order };
    await notifyCaptain(
      saved,
      "Yuvora team entry fee — order created",
      `Order ${order.orderRef} for ${team.name}: pay ₹${order.expectedAmount.toFixed(2)}. ` +
        (paymentsOpen() ? "Open the payment page to scan the UPI QR." : "Payments are opening soon — watch this space.")
    );

    return res.status(201).json({
      ok: true,
      order: { ...publicOrder(saved), ...(await linksFor(saved)) },
      paymentsOpen: paymentsOpen(),
    });
  } catch (err) {
    console.error("POST /api/teams/:teamId/order failed:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Could not create the payment order." });
  }
});

// Load one order — its captain, or any admin.
router.get("/pay/orders/:orderId", requireAuth, async (req, res) => {
  if (!isFirebaseReady()) return notReady(res);
  try {
    let order = await readOrder(req.params.orderId);
    if (!order) return res.status(404).json({ ok: false, error: "Order not found." });
    if (order.captainUid !== req.member.uid && !(await isAdminUid(req.member.uid))) {
      return res.status(403).json({ ok: false, error: "This is not your order." });
    }
    order = await refreshExpiry(order);
    return res.json({ ok: true, order: { ...publicOrder(order), ...(await linksFor(order)) } });
  } catch (err) {
    console.error("GET /api/pay/orders/:orderId failed:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Could not load the order." });
  }
});

// Captain submits the 12-digit UTR of their UPI transfer.
router.post("/pay/orders/:orderId/utr", requireAuth, async (req, res) => {
  if (!isFirebaseReady()) return notReady(res);
  if (!rateLimit(`utr:${clientIp(req)}`, 15, 60_000)) {
    return res.status(429).json({ ok: false, error: "Too many attempts — wait a minute and retry." });
  }
  try {
    const order = await refreshExpiry(await readOrder(req.params.orderId));
    if (!order) return res.status(404).json({ ok: false, error: "Order not found." });
    if (order.captainUid !== req.member.uid) {
      return res.status(403).json({ ok: false, error: "Only the captain can submit this UTR." });
    }
    if (order.status !== "Pending") {
      return res.status(400).json({ ok: false, error: `This order is ${order.status} — UTR can't be changed.` });
    }
    const utr = String(req.body?.utr || "").replace(/\s+/g, "");
    if (!/^\d{12}$/.test(utr)) {
      return res.status(400).json({ ok: false, error: "UTR must be exactly 12 digits." });
    }
    if (order.utr && order.utr !== utr) {
      return res.status(400).json({ ok: false, error: "A UTR is already recorded for this order." });
    }
    if (order.utr !== utr) {
      const claimed = await claimUtr(utr, order.id);
      if (!claimed) {
        return res.status(409).json({ ok: false, error: "That UTR is already used on another order." });
      }
      await rtdb().ref(`paymentOrders/${order.id}`).update({ utr, updatedAt: new Date().toISOString() });
    }
    const updated = { ...order, utr };
    return res.json({ ok: true, order: { ...publicOrder(updated), ...(await linksFor(updated)) } });
  } catch (err) {
    console.error("POST /api/pay/orders/:orderId/utr failed:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Could not save the UTR." });
  }
});

// ================= standalone pay-admin dashboard =================

function adminPasswordConfigured() {
  const h = String(process.env.ADMIN_PASSWORD_HASH || "").trim();
  return !!h && !h.startsWith("PLACEHOLDER");
}

function verifyAdminPassword(password) {
  const stored = String(process.env.ADMIN_PASSWORD_HASH || "").trim();
  if (!adminPasswordConfigured()) return { ok: false, reason: "not-configured" };
  const m = stored.match(/^scrypt\$([0-9a-f]+)\$([0-9a-f]+)$/i);
  if (!m) return { ok: false, reason: "bad-format" };
  const [, saltHex, hashHex] = m;
  const expected = Buffer.from(hashHex, "hex");
  let derived;
  try {
    derived = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  } catch {
    return { ok: false, reason: "error" };
  }
  if (derived.length !== expected.length || !crypto.timingSafeEqual(derived, expected)) {
    return { ok: false, reason: "mismatch" };
  }
  return { ok: true };
}

router.post("/pay-admin/login", (req, res) => {
  // TEMPORARY bypass: PAY_ADMIN_OPEN=true skips the password entirely.
  if (isPayAdminOpen()) {
    return res.json({ ok: true, token: signPaySession(), open: true });
  }
  if (!rateLimit(`paylogin:${clientIp(req)}`, 8, 5 * 60_000)) {
    return res.status(429).json({ ok: false, error: "Too many login attempts — wait 5 minutes." });
  }
  if (!adminPasswordConfigured()) {
    return res.status(503).json({
      ok: false,
      error: "Payments dashboard password is not set. Run `npm run pay:pass` and set ADMIN_PASSWORD_HASH.",
    });
  }
  const password = String(req.body?.password || "");
  if (!password) return res.status(400).json({ ok: false, error: "Enter the dashboard password." });
  const result = verifyAdminPassword(password);
  if (!result.ok) {
    return res.status(401).json({ ok: false, error: "Wrong password." });
  }
  return res.json({ ok: true, token: signPaySession() });
});

router.post("/pay-admin/logout", requirePayAdmin, (_req, res) => {
  return res.json({ ok: true });
});

router.get("/pay-admin/orders", requirePayAdmin, async (req, res) => {
  if (!isFirebaseReady()) return notReady(res);
  try {
    await sweepExpired();
    const status = String(req.query.status || "").trim();
    const snap = await rtdb().ref("paymentOrders").get();
    const val = snap.val() || {};
    const titles = await eventTitles();
    let orders = Object.entries(val).map(([id, o]) => {
      const row = adminOrder({ id, ...o });
      return { ...row, eventTitle: titles[row.eventId] || row.eventId || "", sportName: sportLabel(row.sportId) };
    });
    if (status && ORDER_STATUSES.includes(status)) orders = orders.filter((o) => o.status === status);
    orders.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    return res.json({ ok: true, orders });
  } catch (err) {
    console.error("GET /api/pay-admin/orders failed:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Could not load orders." });
  }
});

router.get("/pay-admin/summary", requirePayAdmin, async (_req, res) => {
  if (!isFirebaseReady()) return notReady(res);
  try {
    await sweepExpired();
    const snap = await rtdb().ref("paymentOrders").get();
    const val = snap.val() || {};
    const counts = Object.fromEntries(ORDER_STATUSES.map((s) => [s, 0]));
    let collected = 0;
    for (const o of Object.values(val)) {
      if (!o) continue;
      if (counts[o.status] != null) counts[o.status] += 1;
      if (o.status === "Confirmed") collected += Number(o.expectedAmount) || 0;
    }
    return res.json({
      ok: true,
      counts,
      totalCollected: Math.round(collected * 100) / 100,
      totalOrders: Object.keys(val).length,
    });
  } catch (err) {
    console.error("GET /api/pay-admin/summary failed:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Could not load the summary." });
  }
});

router.post("/pay-admin/orders/:orderId/status", requirePayAdmin, async (req, res) => {
  if (!isFirebaseReady()) return notReady(res);
  try {
    const order = await readOrder(req.params.orderId);
    if (!order) return res.status(404).json({ ok: false, error: "Order not found." });
    const next = String(req.body?.status || "").trim();
    const note = String(req.body?.note || "").trim().slice(0, 500) || null;
    if (!ORDER_STATUSES.includes(next)) {
      return res.status(400).json({ ok: false, error: `Status must be one of: ${ORDER_STATUSES.join(", ")}.` });
    }
    const nowIso = new Date().toISOString();
    const patch = { status: next, notes: note, updatedAt: nowIso };

    // Releasing a slot/paise once the order no longer occupies it.
    const stillLive = LIVE_STATUSES.includes(next);
    if (!stillLive && order.status !== next) {
      if (order.slotHeld) await releaseSlot(order.eventId);
      if (order.paiseHeld) await releasePaise(order.uniquePaise, order.id);
      patch.slotHeld = false;
      patch.paiseHeld = false;
      if (order.teamId) {
        const idx = (await rtdb().ref(`paymentOrdersByTeam/${order.teamId}`).get()).val();
        if (idx === order.id) await rtdb().ref(`paymentOrdersByTeam/${order.teamId}`).remove();
      }
    }

    if (next === "Confirmed") {
      patch.confirmedAt = nowIso;
      patch.confirmedBy = "pay-admin";
      // Reuse the team's existing paid flag so the admin inspector reflects it.
      if (order.teamId) {
        await rtdb().ref(`teams/${order.teamId}`).update({ paid: true, paidAt: nowIso, paidBy: "pay-admin" });
      }
    } else if (order.status === "Confirmed" && order.teamId) {
      // Un-confirming an order takes the team back to unpaid.
      await rtdb().ref(`teams/${order.teamId}`).update({ paid: false, paidAt: null, paidBy: null });
    }

    await rtdb().ref(`paymentOrders/${order.id}`).update(patch);

    await rtdb().ref("payAudit").push({
      orderId: order.id,
      orderRef: order.orderRef,
      from: order.status,
      to: next,
      note,
      by: "pay-admin",
      at: nowIso,
    });

    if (order.captainUid) {
      await notifyCaptain(
        { ...order, ...patch },
        `Yuvora entry fee — ${next}`,
        `Order ${order.orderRef} (${order.teamName}) is now ${next}.`
      );
    }

    return res.json({ ok: true, order: adminOrder({ ...order, ...patch }) });
  } catch (err) {
    console.error("POST /api/pay-admin/orders/:orderId/status failed:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Could not update the order." });
  }
});

function csvCell(value) {
  const s = String(value == null ? "" : value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

router.get("/pay-admin/orders.csv", requirePayAdmin, async (_req, res) => {
  if (!isFirebaseReady()) return notReady(res);
  try {
    await sweepExpired();
    const snap = await rtdb().ref("paymentOrders").get();
    const val = snap.val() || {};
    const rows = [
      ["date", "order_ref", "team", "event", "sport", "captain", "phone", "email", "players", "amount_inr", "utr", "status", "note"],
    ];
    const titles = await eventTitles();
    const orders = Object.entries(val).map(([id, o]) => ({ id, ...o }));
    orders.sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
    for (const o of orders) {
      rows.push([
        o.createdAt || "",
        o.orderRef || "",
        o.teamName || "",
        titles[o.eventId] || o.eventId || "",
        sportLabel(o.sportId),
        o.captainName || "",
        o.captainPhone || "",
        o.captainEmail || "",
        o.playerCount || "",
        o.expectedAmount != null ? Number(o.expectedAmount).toFixed(2) : "",
        o.utr || "",
        o.status || "",
        o.notes || "",
      ]);
    }
    const csv = rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="yuvora-payments.csv"');
    return res.send(csv);
  } catch (err) {
    console.error("GET /api/pay-admin/orders.csv failed:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Could not build the CSV." });
  }
});

// ---------- Cloudflare Turnstile ----------
async function verifyTurnstile(token, remoteip) {
  try {
    const body = new URLSearchParams({ secret: CAPTCHA_SECRET, response: token });
    if (remoteip && remoteip !== "unknown") body.set("remoteip", remoteip);
    const resp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = await resp.json().catch(() => null);
    return !!(data && data.success === true);
  } catch {
    return false;
  }
}

// Pure helpers exported for unit tests (test/payments.test.js).
export { resolveBaseFee, maxTeamsFor, buildUpiLink, paymentsOpen, safeId, csvCell, verifyAdminPassword };

export default router;
