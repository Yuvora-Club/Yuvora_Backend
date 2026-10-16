// DESTRUCTIVE database reset + reseed. Handle with care.
// Usage:
//   npm run seed:reset -- --confirm-wipe [--with-welcome]
//
// Without --confirm-wipe this script only PRINTS what it would destroy and
// exits — it never deletes by accident (e.g. a bare `npm run seed:reset`).
//
// With --confirm-wipe it:
//   1. Deletes EVERY Firebase Auth account in the project.
//   2. Removes the `users` and `announcements` Realtime Database nodes.
//   3. Creates exactly ONE user — Rishith Manchala, role "admin".
//   4. Optionally (--with-welcome) pins one welcome notice authored by him
//      (off by default, so the member board stays empty until he posts).
//
// Reads Firebase Admin credentials from Backend/.env (never committed).

import "dotenv/config";
import { initFirebase, auth, rtdb } from "../src/firebase.js";

const ADMIN = {
  fullName: "Rishith Manchala",
  email: "rishithamnchala989@gmail.com",
  password: "Rishith@1234",
  phone: "7075224965",
  birthDate: "2011-03-14", // 14 Mar 2011 -> age 15 in 2026; auto-increments yearly
};

const WELCOME = {
  title: "Welcome to the notice board ✿",
  tag: "General",
  body: "This is where crew notices land — newest first. Watch this space for leagues, builds and moon socials.",
};

const args = new Set(process.argv.slice(2));
const CONFIRMED = args.has("--confirm-wipe");
const WITH_WELCOME = args.has("--with-welcome");

function ageFromBirthDate(birthDate, now = new Date()) {
  const m = String(birthDate || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  let age = now.getFullYear() - y;
  if (now.getMonth() + 1 < mo || (now.getMonth() + 1 === mo && now.getDate() < d)) age -= 1;
  return age;
}

async function countAuthUsers() {
  let total = 0;
  let pageToken = undefined;
  do {
    const page = await auth().listUsers(1000, pageToken);
    total += page.users.length;
    pageToken = page.pageToken;
  } while (pageToken);
  return total;
}

async function deleteAllAuthUsers() {
  let deleted = 0;
  let pageToken = undefined;
  do {
    const page = await auth().listUsers(1000, pageToken);
    const uids = page.users.map((u) => u.uid);
    if (uids.length > 0) {
      const res = await auth().deleteUsers(uids);
      deleted += res.successCount;
      if (res.errors.length > 0) {
        for (const e of res.errors) console.error(`[reset] delete failed for ${e.index}: ${e.error}`);
      }
    }
    pageToken = page.pageToken;
  } while (pageToken);
  return deleted;
}

async function countChildren(node) {
  try {
    const snap = await rtdb().ref(node).get();
    const val = snap.val();
    return val && typeof val === "object" ? Object.keys(val).length : 0;
  } catch {
    return 0;
  }
}

async function main() {
  const fb = initFirebase();
  if (!fb.ready) {
    console.error(`[reset] Firebase NOT configured — missing: ${fb.missing.join(", ")}`);
    process.exit(1);
  }

  const authCount = await countAuthUsers();
  const usersCount = await countChildren("users");
  const annCount = await countChildren("announcements");

  if (!CONFIRMED) {
    console.log("[reset] DRY RUN — nothing was touched. To actually wipe, re-run with --confirm-wipe.");
    console.log(`[reset] Would delete: ${authCount} Auth account(s), ${usersCount} user profile(s), ${annCount} announcement(s).`);
    console.log(`[reset] Would create: 1 admin — ${ADMIN.fullName} <${ADMIN.email}> (birthDate ${ADMIN.birthDate}, age ${ageFromBirthDate(ADMIN.birthDate)}, role admin).`);
    console.log(`[reset] Welcome notice: ${WITH_WELCOME ? "YES (--with-welcome)" : "no (pass --with-welcome to pin one)"}.`);
    process.exit(1);
  }

  console.log(`[reset] Wiping: ${authCount} Auth account(s)...`);
  const deleted = await deleteAllAuthUsers();
  console.log(`[reset] Deleted ${deleted} Auth account(s).`);

  console.log(`[reset] Removing RTDB nodes: users (${usersCount}), announcements (${annCount})...`);
  await rtdb().ref("users").remove();
  await rtdb().ref("announcements").remove();

  const email = ADMIN.email.trim().toLowerCase();
  const record = await auth().createUser({
    displayName: ADMIN.fullName,
    email,
    password: ADMIN.password,
    emailVerified: false,
    disabled: false,
  });
  await auth().setCustomUserClaims(record.uid, { admin: true, role: "admin" });

  const now = new Date().toISOString();
  const profile = {
    fullName: ADMIN.fullName,
    email,
    altEmail: null,
    phone: ADMIN.phone,
    birthDate: ADMIN.birthDate,
    age: ageFromBirthDate(ADMIN.birthDate),
    role: "admin",
    termsAcceptedAt: now,
    createdAt: now,
    seededAt: now,
    updatedAt: now,
    provider: "password",
  };
  await rtdb().ref(`users/${record.uid}`).set(profile);
  console.log(`[reset] Seeded admin ${record.uid}: ${profile.fullName}, age ${profile.age}, role admin.`);

  if (WITH_WELCOME) {
    const ref = rtdb().ref("announcements").push();
    await ref.set({ ...WELCOME, authorUid: record.uid, createdAt: now, updatedAt: now });
    console.log(`[reset] Pinned welcome notice ${ref.key}.`);
  }

  console.log("[reset] Done. Database holds exactly 1 user (admin). Log in, then open /admin.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[reset] failed:", err?.code || err?.message || err);
  process.exit(1);
});
