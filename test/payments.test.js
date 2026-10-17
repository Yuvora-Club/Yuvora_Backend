// Unit tests for the pure money/config helpers in src/routes/payments.js.
//
// The route module reads its configuration from the environment once, at
// import time, so each scenario re-imports it under a distinct URL query
// with the env vars that scenario needs. The default import (no env set)
// is the placeholder mode the site ships with.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const closed = await import("../src/routes/payments.js");

async function loadWith(env, tag) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return await import(`../src/routes/payments.js?${tag}`);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const open = await loadWith(
  { UPI_ID: "yuvora@okaxis", PAYEE_NAME: "Yuvora Club", ENTRY_FEE_PER_TEAM: "900" },
  "open"
);
const player = await loadWith({ FEE_MODE: "player", FEE_PER_PLAYER: "100" }, "player");

test("payments stay dormant while UPI_ID is still a placeholder", () => {
  assert.equal(closed.paymentsOpen(), false);
  assert.equal(open.paymentsOpen(), true);
});

test("fee precedence: per-sport fee, then event entry fee, then environment", () => {
  assert.equal(open.resolveBaseFee({ sportFees: { cricket: 700 } }, "cricket", 11), 700);
  assert.equal(open.resolveBaseFee({ entryFee: 1200 }, "cricket", 11), 1200);
  assert.equal(open.resolveBaseFee({}, "cricket", 11), 900);
  assert.equal(closed.resolveBaseFee({}, "cricket", 11), 1500);
  // A blank/invalid per-sport fee falls through to the event's base fee.
  assert.equal(open.resolveBaseFee({ sportFees: { cricket: null }, entryFee: 500 }, "cricket", 11), 500);
  // A fee set for a different sport does not leak into this one.
  assert.equal(open.resolveBaseFee({ sportFees: { football: 650 } }, "cricket", 11), 900);
  // An explicit 0 is a deliberate free entry; blank/junk is not a fee at all.
  assert.equal(open.resolveBaseFee({ sportFees: { cricket: 0 } }, "cricket", 11), 0);
  assert.equal(open.resolveBaseFee({ entryFee: "free" }, "cricket", 11), 900);
});

test("fee is always a whole, non-negative rupee amount", () => {
  assert.equal(open.resolveBaseFee({ entryFee: 499.6 }, "cricket", 2), 500);
  assert.equal(open.resolveBaseFee({ entryFee: -50 }, "cricket", 2), 0);
});

test("player mode charges FEE_PER_PLAYER x players, never below one player", () => {
  assert.equal(player.resolveBaseFee({}, "badminton", 4), 400);
  assert.equal(player.resolveBaseFee({}, "badminton", 0), 100);
});

test("team cap: event override wins, otherwise the global cap (0 = unlimited)", () => {
  assert.equal(open.maxTeamsFor({ maxTeams: 5 }), 5);
  assert.equal(open.maxTeamsFor({ maxTeams: 0 }), 0);
  assert.equal(open.maxTeamsFor({}), 0);
  assert.equal(open.maxTeamsFor({ maxTeams: "twelve" }), 0);
});

test("UPI link carries the exact paise-accurate amount", () => {
  const link = open.buildUpiLink(1500.5, "YUVORA-ORD-1");
  assert.ok(link.startsWith("upi://pay?"));
  const params = new URLSearchParams(link.split("?")[1]);
  assert.equal(params.get("pa"), "yuvora@okaxis");
  assert.equal(params.get("pn"), "Yuvora Club");
  assert.equal(params.get("am"), "1500.50");
  assert.equal(params.get("cu"), "INR");
  assert.equal(params.get("tn"), "YUVORA-ORD-1");
  assert.equal(new URLSearchParams(open.buildUpiLink(1500, "r").split("?")[1]).get("am"), "1500.00");
});

test("safeId refuses characters Firebase treats as path syntax", () => {
  assert.equal(open.safeId("LmXyZ-abc_123"), "LmXyZ-abc_123");
  assert.equal(open.safeId("  team1  "), "team1");
  for (const bad of ["", "   ", "a.b", "a#b", "a$b", "a[b]", "a]b"]) {
    assert.equal(open.safeId(bad), null, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test("csvCell quotes separators, quotes and newlines", () => {
  assert.equal(open.csvCell("plain"), "plain");
  assert.equal(open.csvCell(null), "");
  assert.equal(open.csvCell(1500), "1500");
  assert.equal(open.csvCell("a,b"), '"a,b"');
  assert.equal(open.csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(open.csvCell("one\ntwo"), '"one\ntwo"');
});

test("pay-admin password check accepts only a matching scrypt hash", () => {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync("correct horse", salt, 32);
  const saved = process.env.ADMIN_PASSWORD_HASH;
  try {
    process.env.ADMIN_PASSWORD_HASH = `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
    assert.deepEqual(open.verifyAdminPassword("correct horse"), { ok: true });
    assert.equal(open.verifyAdminPassword("wrong").reason, "mismatch");

    process.env.ADMIN_PASSWORD_HASH = "PLACEHOLDER_ADMIN_HASH";
    assert.equal(open.verifyAdminPassword("correct horse").reason, "not-configured");

    process.env.ADMIN_PASSWORD_HASH = "plaintext-password";
    assert.equal(open.verifyAdminPassword("correct horse").reason, "bad-format");
  } finally {
    if (saved === undefined) delete process.env.ADMIN_PASSWORD_HASH;
    else process.env.ADMIN_PASSWORD_HASH = saved;
  }
});
