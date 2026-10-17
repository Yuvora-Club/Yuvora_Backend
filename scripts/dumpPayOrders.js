// Dump payment dashboard data DIRECTLY from RTDB — bypasses /pay-admin password.
// Use this when you lost the dashboard password but have Firebase Admin access.
//
// Setup: Backend/.env must have FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL,
//   FIREBASE_PRIVATE_KEY (with \n escaped), FIREBASE_DATABASE_URL
//   (same values as on Render > service > Environment).
//
// Run:  Set-Location Backend; node scripts/dumpPayOrders.js; Set-Location ..
//   Optional filter: node scripts/dumpPayOrders.js --status=Pending
//   CSV export:      node scripts/dumpPayOrders.js --csv=pay-orders.csv
//
// This does NOT recover the dashboard password — that password is NEVER stored
// in the DB. It only exists as scrypt hash in ADMIN_PASSWORD_HASH env var.
// To regain dashboard access, rotate it with: npm run pay:pass -- "new-password"
// then set the SAME hash on Render and redeploy.

import "dotenv/config";
import fs from "node:fs";
import { initFirebase, rtdb } from "../src/firebase.js";

function arg(name) {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  return p ? p.slice(name.length + 3) : "";
}

async function main() {
  const fb = initFirebase();
  if (!fb.ready) {
    console.error(`[dump] Firebase NOT configured — missing: ${fb.missing.join(", ")}`);
    console.error("[dump] Fill Backend/.env from Firebase Console > Project settings > Service accounts.");
    process.exit(1);
  }

  const statusFilter = arg("status");
  const csvPath = arg("csv");

  const snap = await rtdb().ref("paymentOrders").get();
  const val = snap.val() || {};
  let orders = Object.entries(val).map(([id, o]) => ({ id, ...o }));
  orders.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  if (statusFilter) orders = orders.filter((o) => o.status === statusFilter);

  console.log(`[dump] ${orders.length} order(s)${statusFilter ? ` with status=${statusFilter}` : ""}`);
  for (const o of orders) {
    console.log(
      `- ${o.orderRef || o.id} | ${o.status} | team=${o.teamName || o.teamId} | event=${o.eventId} | amount=₹${o.amount ?? "?"} paise=${o.uniquePaise ?? "?"} | utr=${o.utr || "-"} | captain=${o.captainEmail || o.captainUid || "-"}`
    );
  }

  // Summary counts
  const counts = {};
  let collected = 0;
  for (const o of Object.values(val)) {
    counts[o.status] = (counts[o.status] || 0) + 1;
    if (o.status === "Confirmed") collected += Number(o.amount || 0);
  }
  console.log("[dump] counts:", counts, `collected=₹${collected}`);

  if (csvPath) {
    const cols = ["id", "orderRef", "status", "teamName", "eventId", "amount", "uniquePaise", "utr", "createdAt"];
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [cols.join(","), ...orders.map((o) => cols.map((c) => esc(o[c])).join(","))];
    fs.writeFileSync(csvPath, lines.join("\n"));
    console.log(`[dump] CSV written to ${csvPath}`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("[dump] failed:", e?.message || e);
  process.exit(1);
});
