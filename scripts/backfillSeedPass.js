// Backfill stable seed-pass codes for members who joined before the feature,
// and enrich the reverse index so every entry carries its owner's name.
// Run:  Set-Location Backend; node scripts/backfillSeedPass.js; Set-Location ..
// Reads Firebase Admin credentials from Backend/.env. Idempotent — skips
// users who already have a valid YV-XXXX code (topping up the index entry
// with name+email when missing). Prints every code so you can hand them
// out at the gate.

import "dotenv/config";
import { initFirebase, rtdb } from "../src/firebase.js";

function codeFromUid(uid) {
  let h = 0x811c9dc5;
  const s = String(uid || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h % 9000) + 1000;
}

async function main() {
  const fb = initFirebase();
  if (!fb.ready) {
    console.error(`[seedpass] Firebase NOT configured — missing: ${fb.missing.join(", ")}`);
    process.exit(1);
  }
  const snap = await rtdb().ref("users").get();
  const users = snap.val() || {};
  const ids = Object.keys(users);
  console.log(`[seedpass] ${ids.length} user(s) found.`);
  let minted = 0;
  let kept = 0;
  for (const uid of ids) {
    const p = users[uid] || {};
    const who = {
      uid,
      fullName: String(p.fullName || p.name || ""),
      email: String(p.email || "").toLowerCase(),
      updatedAt: new Date().toISOString(),
    };
    const existing = String(p.seedPassCode || "").trim().toUpperCase();
    if (/^YV-\d{4}$/.test(existing)) {
      try {
        const idx = await rtdb().ref(`seedPassIndex/${existing}`).get();
        const val = idx.val();
        if (!val) await rtdb().ref(`seedPassIndex/${existing}`).set(who);
        else if (val.uid === uid && (!val.fullName || !val.email)) {
          await rtdb().ref(`seedPassIndex/${existing}`).update({
            fullName: who.fullName,
            email: who.email,
            updatedAt: who.updatedAt,
          });
          console.log(`[seedpass] enrich ${who.fullName || who.email || uid} -> ${existing}`);
        }
      } catch { /* best-effort */ }
      console.log(`[seedpass] keep  ${p.fullName || p.email || uid} -> ${existing}`);
      kept++;
      continue;
    }
    let num = codeFromUid(uid);
    let code = null;
    for (let tries = 0; tries < 9000; tries++) {
      const candidate = `YV-${String(num)}`;
      const idx = await rtdb().ref(`seedPassIndex/${candidate}`).get();
      const val = idx.val();
      if (!val || val.uid === uid) {
        code = candidate;
        break;
      }
      num = num >= 9999 ? 1000 : num + 1;
    }
    if (!code) {
      console.log(`[seedpass] FAIL  ${p.fullName || p.email || uid} — no free code`);
      continue;
    }
    await rtdb().ref(`users/${uid}`).update({ seedPassCode: code });
    await rtdb().ref(`seedPassIndex/${code}`).set({
      uid,
      fullName: String(p.fullName || p.name || ""),
      email: String(p.email || "").toLowerCase(),
      updatedAt: new Date().toISOString(),
    });
    console.log(`[seedpass] mint  ${p.fullName || p.email || uid} -> ${code}`);
    minted++;
  }
  console.log(`[seedpass] done — ${minted} minted, ${kept} already had codes.`);
  process.exit(0);
}

main().catch((e) => {
  console.error("[seedpass] failed:", e?.message || e);
  process.exit(1);
});
