// diagSeedPass.js — one-shot diagnosis for the gate verifier.
// Answers, against the REAL database this Backend/.env points at:
//   1. Does the chained orderByChild().equalTo().get() query throw? (verify 500)
//   2. Are there any members with a seedPassCode at all? (verify 404)
//   3. Does seedPassIndex match users/? (stale/dangling entries)
// Run: npm run seedpass:diag  (node scripts/diagSeedPass.js)
// Same FIREBASE_* env as Render => this IS what production sees.

import "dotenv/config";
import { initFirebase, rtdb } from "../src/firebase.js";

const fb = initFirebase();
if (!fb.ready) {
  console.error("[diag] Firebase NOT ready. Missing:", fb.missing.join(", "));
  process.exit(1);
}

const YV = /^YV-\d{4}$/;

async function main() {
  const db = rtdb();
  console.log("[diag] database:", process.env.FIREBASE_DATABASE_URL);
  console.log("[diag] project :", process.env.FIREBASE_PROJECT_ID);

  // 1) The exact query shape the verify route used to run.
  try {
    const snap = await db.ref("seedPassScans").orderByChild("code").equalTo("YV-0000").get();
    console.log(`[ok]   chained orderByChild().equalTo().get() — exists=${snap.exists()}`);
  } catch (e) {
    console.log(`[FAIL] chained query THREW: ${e.message}`);
  }

  // 2) Plain get on the same node.
  try {
    const snap = await db.ref("seedPassScans").get();
    console.log(`[ok]   plain seedPassScans.get() — children=${snap.numChildren()}`);
  } catch (e) {
    console.log(`[FAIL] plain get THREW: ${e.message}`);
  }

  // 3) users/ + who has a code.
  const users = (await db.ref("users").get()).val() || {};
  const entries = Object.entries(users);
  const coded = entries.filter(([, p]) => YV.test(String(p?.seedPassCode || "").trim().toUpperCase()));
  console.log(`[ok]   users total=${entries.length}  withSeedPassCode=${coded.length}`);
  for (const [id, p] of coded.slice(0, 8)) {
    console.log(`         ${String(p.seedPassCode)}  ${p.fullName || "?"}  (${id.slice(0, 12)}…)`);
  }

  // 4) reverse index health.
  const index = (await db.ref("seedPassIndex").get()).val() || {};
  const idxKeys = Object.keys(index);
  console.log(`[ok]   seedPassIndex entries=${idxKeys.length}`);
  let dangling = 0;
  let mismatched = 0;
  for (const [code, v] of Object.entries(index)) {
    const uid = v?.uid;
    if (!uid || !users[uid]) {
      dangling++;
      console.log(`         DANGLING ${code} -> uid ${uid || "(none)"} not in users/`);
      continue;
    }
    const stored = String(users[uid]?.seedPassCode || "").trim().toUpperCase();
    if (stored !== code) {
      mismatched++;
      console.log(`         MISMATCH ${code} -> user's stored code is '${stored || "(none)"}'`);
    }
  }
  console.log(`[ok]   dangling=${dangling}  mismatched=${mismatched}`);

  // 5) codes stored in users/ but MISSING from the index (verify would rely on sweep).
  let missingIdx = 0;
  for (const [id, p] of coded) {
    const code = String(p.seedPassCode).trim().toUpperCase();
    if (!index[code]) {
      missingIdx++;
      console.log(`         NOT INDEXED ${code} (${p.fullName || id}) — sweep would still find it`);
    }
  }
  console.log(`[ok]   coded-but-unindexed=${missingIdx}`);

  process.exit(0);
}

main().catch((e) => {
  console.error("[diag] crashed:", e?.stack || e);
  process.exit(1);
});
