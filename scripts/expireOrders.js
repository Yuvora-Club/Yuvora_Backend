// Expire stale Pending payment orders and free their slot + unique paise.
// Run manually:  npm run pay:expire
// Also safe to schedule (e.g. Render cron) — it is idempotent.
//
// The API also expires orders lazily on read; this script keeps the database
// tidy when nobody visits. Reads Firebase Admin credentials from Backend/.env.

import "dotenv/config";
import { initFirebase, rtdb } from "../src/firebase.js";

async function releaseSlot(eventId) {
  if (!eventId) return;
  await rtdb()
    .ref(`paymentEventCounters/${eventId}/used`)
    .transaction((cur) => {
      const used = typeof cur === "number" ? cur : 0;
      return used > 0 ? used - 1 : 0;
    });
}

async function releasePaise(paise, orderId) {
  if (!paise) return;
  await rtdb()
    .ref(`paymentPaise/${paise}`)
    .transaction((cur) => (cur === orderId ? null : undefined));
}

async function main() {
  const fb = initFirebase();
  if (!fb.ready) {
    console.error(`[pay:expire] Firebase NOT configured — missing: ${fb.missing.join(", ")}`);
    process.exit(1);
  }

  const snap = await rtdb().ref("paymentOrders").get();
  const val = snap.val() || {};
  const now = Date.now();
  let expired = 0;

  for (const [id, o] of Object.entries(val)) {
    if (!o || o.status !== "Pending") continue;
    const t = Date.parse(o.expiresAt || "");
    if (!Number.isFinite(t) || t > now) continue;

    if (o.slotHeld) await releaseSlot(o.eventId);
    if (o.paiseHeld) await releasePaise(o.uniquePaise, id);
    await rtdb().ref(`paymentOrders/${id}`).update({
      status: "Expired",
      slotHeld: false,
      paiseHeld: false,
      updatedAt: new Date().toISOString(),
    });
    if (o.teamId) {
      const idx = (await rtdb().ref(`paymentOrdersByTeam/${o.teamId}`).get()).val();
      if (idx === id) await rtdb().ref(`paymentOrdersByTeam/${o.teamId}`).remove();
    }
    expired += 1;
    console.log(`[pay:expire] expired ${o.orderRef || id} (${o.teamName || "team"})`);
  }

  console.log(`[pay:expire] done — ${expired} order(s) expired.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[pay:expire] failed:", err?.message || err);
  process.exit(1);
});
