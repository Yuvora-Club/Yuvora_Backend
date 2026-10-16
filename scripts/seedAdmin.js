// Seed the ONE initial admin user: Rishith Manchala.
// Run:  Set-Location Backend; npm run seed:admin; Set-Location ..
// Reads Firebase Admin credentials from Backend/.env (never committed).
//
// NOTE on the birth date: the request says age 15 with birth date
// 14/03/2026 — that date would make age 0 in 2026, so the YEAR is treated
// as a typo and stored as 2011-03-14 (14 Mar 2011 -> age 15 in Oct 2026).
// Age is always computed from birthDate (birthday-aware), so it increments
// automatically every year without re-seeding.

import "dotenv/config";
import { initFirebase, auth, rtdb } from "../src/firebase.js";

const ADMIN = {
  fullName: "Rishith Manchala",
  email: "rishithamnchala989@gmail.com",
  password: "Rishith@1234",
  phone: "7075224965",
  birthDate: "2011-03-14",
};

function ageFromBirthDate(birthDate, now = new Date()) {
  const m = String(birthDate || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  let age = now.getFullYear() - y;
  const beforeBirthday =
    now.getMonth() + 1 < mo || (now.getMonth() + 1 === mo && now.getDate() < d);
  if (beforeBirthday) age -= 1;
  return age;
}

async function main() {
  const fb = initFirebase();
  if (!fb.ready) {
    console.error(`[seed:admin] Firebase NOT configured — missing: ${fb.missing.join(", ")}`);
    console.error("[seed:admin] Copy Backend/.env.example to Backend/.env and fill it, then retry.");
    process.exit(1);
  }

  const email = ADMIN.email.trim().toLowerCase();
  let record;
  try {
    record = await auth().getUserByEmail(email);
    console.log(`[seed:admin] Found existing Auth user ${record.uid} — updating to admin.`);
    await auth().updateUser(record.uid, {
      displayName: ADMIN.fullName,
      password: ADMIN.password,
      disabled: false,
    });
    record = await auth().getUserByEmail(email);
  } catch (err) {
    if (err?.code !== "auth/user-not-found") throw err;
    record = await auth().createUser({
      displayName: ADMIN.fullName,
      email,
      password: ADMIN.password,
      emailVerified: false,
      disabled: false,
    });
    console.log(`[seed:admin] Created Auth user ${record.uid}.`);
  }

  await auth().setCustomUserClaims(record.uid, { admin: true, role: "admin" });

  const now = new Date().toISOString();
  const age = ageFromBirthDate(ADMIN.birthDate);
  let prev = null;
  try {
    prev = (await rtdb().ref(`users/${record.uid}`).get()).val() || null;
  } catch {
    prev = null;
  }
  const profile = {
    fullName: ADMIN.fullName,
    email,
    altEmail: (prev && prev.altEmail) || null,
    phone: ADMIN.phone,
    birthDate: ADMIN.birthDate,
    age,
    role: "admin",
    termsAcceptedAt: (prev && prev.termsAcceptedAt) || now,
    createdAt: (prev && prev.createdAt) || now,
    seededAt: now,
    updatedAt: now,
    provider: "password",
  };
  await rtdb().ref(`users/${record.uid}`).set(profile);

  console.log("[seed:admin] Admin profile written to users/" + record.uid);
  console.log(
    JSON.stringify(
      { uid: record.uid, fullName: profile.fullName, email, phone: profile.phone, birthDate: profile.birthDate, age, role: "admin" },
      null,
      2
    )
  );
  console.log("[seed:admin] Done. Log in as this user, then open /admin.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[seed:admin] failed:", err?.code || err?.message || err);
  process.exit(1);
});
