// Prune every account EXCEPT Rishith Manchala (the keeper admin).
// Usage:
//   npm run prune          -> lists all accounts, deletes NOTHING
//   npm run prune -- --confirm -> deletes every other account + their traces
//
// What --confirm destroys (keeper untouched):
//   1. Every Firebase Auth account except the keeper's.
//   2. Their `users/{uid}` profiles.
//   3. Their team memberships + join requests.
//   4. Teams left with no members or whose captain is gone (with requests).
// Announcements are left alone (they're board content, not accounts).

import "dotenv/config";
import { initFirebase, auth, rtdb } from "../src/firebase.js";

const KEEPER_EMAIL = "rishithmanchala989@gmail.com";
const CONFIRMED = new Set(process.argv.slice(2)).has("--confirm");

async function allAuthUsers() {
  const users = [];
  let pageToken = undefined;
  do {
    const page = await auth().listUsers(1000, pageToken);
    users.push(...page.users);
    pageToken = page.pageToken;
  } while (pageToken);
  return users;
}

async function main() {
  const fb = initFirebase();
  if (!fb.ready) {
    console.error(`[prune] Firebase NOT configured — missing: ${fb.missing.join(", ")}`);
    process.exit(1);
  }

  const authUsers = await allAuthUsers();
  const keeper = authUsers.find((u) => (u.email || "").toLowerCase() === KEEPER_EMAIL);
  const others = authUsers.filter((u) => (u.email || "").toLowerCase() !== KEEPER_EMAIL);

  const usersSnap = await rtdb().ref("users").get();
  const profiles = usersSnap.val() || {};
  const keeperUid = keeper ? keeper.uid : null;
  const otherUids = new Set([
    ...others.map((u) => u.uid),
    ...Object.keys(profiles).filter((uid) => uid !== keeperUid),
  ]);

  console.log(`[prune] Keeper: ${keeper ? `${keeper.email} (${keeper.uid})` : "NOT FOUND!"}`);
  console.log(`[prune] Other Auth accounts: ${others.length}`);
  for (const u of others) {
    console.log(`  - ${u.email || "(no email)"} uid=${u.uid} disabled=${u.disabled}`);
  }
  const orphanProfiles = Object.keys(profiles).filter(
    (uid) => uid !== keeperUid && !others.some((u) => u.uid === uid)
  );
  if (orphanProfiles.length > 0) {
    console.log(`[prune] Orphan profiles (no Auth account): ${orphanProfiles.length}`);
    for (const uid of orphanProfiles) {
      const p = profiles[uid] || {};
      console.log(`  - ${p.fullName || p.email || uid}`);
    }
  }

  if (!keeper) {
    console.error("[prune] ABORT: keeper account not found — refusing to wipe blindly.");
    process.exit(1);
  }
  if (!CONFIRMED) {
    console.log(`[prune] DRY RUN — nothing deleted. Re-run with --confirm to remove ${otherUids.size} account(s) and their traces.`);
    process.exit(0);
  }
  if (otherUids.size === 0) {
    console.log("[prune] Nothing to delete — only the keeper exists.");
    process.exit(0);
  }

  // 1. Auth accounts.
  const uids = [...otherUids].filter((uid) => others.some((u) => u.uid === uid));
  if (uids.length > 0) {
    const res = await auth().deleteUsers(uids);
    console.log(`[prune] Deleted ${res.successCount} Auth account(s).`);
  }

  // 2. Profiles.
  for (const uid of otherUids) {
    await rtdb().ref(`users/${uid}`).remove();
  }
  console.log(`[prune] Removed ${otherUids.size} profile(s).`);

  // 3+4. Team traces: drop their memberships/requests, delete gutted teams.
  const teamsSnap = await rtdb().ref("teams").get();
  const teams = teamsSnap.val() || {};
  let membersDropped = 0;
  let teamsDeleted = 0;
  for (const [teamId, t] of Object.entries(teams)) {
    let changed = false;
    for (const uid of otherUids) {
      if (t.members && t.members[uid]) {
        delete t.members[uid];
        membersDropped++;
        changed = true;
      }
      await rtdb().ref(`teamRequests/${teamId}/${uid}`).remove();
    }
    const remaining = Object.keys(t.members || {});
    if (remaining.length === 0 || (t.captainUid && otherUids.has(t.captainUid))) {
      await rtdb().ref(`teams/${teamId}`).remove();
      await rtdb().ref(`teamRequests/${teamId}`).remove();
      teamsDeleted++;
    } else if (changed) {
      const locked = remaining.length >= (t.maxPlayers || 999);
      await rtdb().ref(`teams/${teamId}/members`).set(t.members);
      await rtdb().ref(`teams/${teamId}`).update({ locked });
    }
  }
  console.log(`[prune] Dropped ${membersDropped} membership(s), deleted ${teamsDeleted} gutted team(s).`);
  console.log("[prune] Done. Only the keeper admin remains.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[prune] failed:", err?.code || err?.message || err);
  process.exit(1);
});
