// Standalone payments-admin session — SEPARATE from the Firebase admin login.
//
// The payments dashboard is unlocked with ADMIN_PASSWORD_HASH (set via
// `npm run pay:pass`) and receives a short-lived, HMAC-signed session token.
// The SPA keeps the token in sessionStorage and sends it as a Bearer header on
// every /api/pay-admin/* call (cross-site cookie-free, so no CORS-credentials
// or CSRF dance is needed). The token is stateless: payload + signature.

import crypto from "node:crypto";

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

function sessionSecret() {
  return String(
    process.env.PAY_ADMIN_SECRET ||
      process.env.ADMIN_PASSWORD_HASH ||
      "yuvora-pay-dev-secret"
  );
}

/** TEMPORARY bypass — set PAY_ADMIN_OPEN=true to open /pay-admin with no password. */
export function isPayAdminOpen() {
  return ["1", "true", "yes", "open"].includes(
    String(process.env.PAY_ADMIN_OPEN || "").trim().toLowerCase()
  );
}

function sign(payload) {
  return crypto.createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
}

/** Mint a fresh signed session token for the payments dashboard. */
export function signPaySession() {
  const payload = Buffer.from(
    JSON.stringify({ role: "payadmin", exp: Date.now() + SESSION_TTL_MS })
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function verifyPaySession(token) {
  const [payload, sig] = String(token || "").split(".");
  if (!payload || !sig) return null;
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!data || data.role !== "payadmin" || !(Number(data.exp) > Date.now())) return null;
  return data;
}

/** Gate for /api/pay-admin/* — attaches req.payAdmin on success. */
export function requirePayAdmin(req, res, next) {
  if (isPayAdminOpen()) {
    req.payAdmin = { role: "payadmin", open: true };
    return next();
  }
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const data = verifyPaySession(token);
  if (!data) {
    return res.status(401).json({ ok: false, error: "Payments dashboard login required." });
  }
  req.payAdmin = data;
  return next();
}
