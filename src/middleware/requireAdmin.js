// requireAdmin — verifies a Firebase ID token, then checks the RTDB profile
// `users/{uid}` has role === "admin" (or an `admin: true` custom claim).
// The frontend sends the ID token from POST /api/auth/login as:
//   Authorization: Bearer <idToken>
// Admins must LOG IN (not just Join) so the frontend holds a real ID token
// — Join only returns a customToken, which cannot be verified here.

import { auth, rtdb, isFirebaseReady } from "../firebase.js";

function noFirebase(res) {
  return res.status(503).json({
    ok: false,
    error: "Firebase is not configured on the backend yet. Fill Backend/.env first.",
  });
}

function noToken(res) {
  return res.status(401).json({
    ok: false,
    error: "Admin sign-in required. Log in as an admin (POST /api/auth/login) and retry.",
  });
}

function forbidden(res) {
  return res.status(403).json({
    ok: false,
    error: "This account is not an admin.",
  });
}

export async function requireAdmin(req, res, next) {
  if (!isFirebaseReady()) return noFirebase(res);
  const header = String(req.headers.authorization || "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return noToken(res);
  const idToken = match[1].trim();
  if (!idToken) return noToken(res);

  let decoded;
  try {
    decoded = await auth().verifyIdToken(idToken);
  } catch {
    return res.status(401).json({
      ok: false,
      error: "Admin session expired or invalid. Please log in again (POST /api/auth/login).",
    });
  }

  // Custom claim shortcut — set by scripts/seedAdmin.js + POST /api/admin/users.
  if (decoded && (decoded.admin === true || decoded.role === "admin")) {
    req.admin = { uid: decoded.uid, email: decoded.email || null, via: "claim" };
    return next();
  }

  try {
    const snap = await rtdb().ref(`users/${decoded.uid}`).get();
    const profile = snap.val() || null;
    if (profile && profile.role === "admin") {
      req.admin = { uid: decoded.uid, email: profile.email || decoded.email || null, via: "profile" };
      return next();
    }
  } catch (err) {
    console.error("[admin] profile lookup failed:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Could not verify admin status. Try again." });
  }
  return forbidden(res);
}
