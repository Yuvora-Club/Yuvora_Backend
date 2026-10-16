// requireAuth — any signed-in Firebase user (member or admin).
// Sends the ID token from POST /api/auth/login as:
//   Authorization: Bearer <idToken>
// Attaches req.member = { uid, email }.

import { auth, isFirebaseReady } from "../firebase.js";

export async function requireAuth(req, res, next) {
  if (!isFirebaseReady()) {
    return res.status(503).json({
      ok: false,
      error: "Firebase is not configured on the backend yet. Fill Backend/.env first.",
    });
  }
  const header = String(req.headers.authorization || "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return res.status(401).json({
      ok: false,
      error: "Sign-in required. Log in and retry.",
    });
  }
  try {
    const decoded = await auth().verifyIdToken(match[1].trim());
    req.member = { uid: decoded.uid, email: decoded.email || null, name: decoded.name || null };
    return next();
  } catch {
    return res.status(401).json({
      ok: false,
      error: "Session expired or invalid. Please log in again.",
    });
  }
}
