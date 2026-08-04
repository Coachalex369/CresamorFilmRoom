/*
  authenticate.js — Beta Readiness Sprint 2. The "who are you" half of the
  auth split (see authorize.js for "what can you do"). Every protected
  route gets this first, before any authorize.js check.

  The JWT payload is deliberately minimal now — just { id } (see auth.js).
  email/role are never trusted from the token itself: they're reloaded
  from Postgres on every request, so a role change or account deletion
  takes effect on the very next request instead of waiting out a 7-day
  token expiry. req.user is intentionally narrow ({ id, email, role }) —
  no password hash, no other profile fields.

  Every rejection path (missing header, malformed header, bad signature,
  expired token, token id no longer in users) returns the same generic
  401 message, so a caller can't fingerprint *why* a token failed by
  response content, and gets audit-logged as auth_rejected for visibility
  into probing behavior.
*/

const jwt = require("jsonwebtoken");

const client = require("../db/client");
const { logSecurityEvent } = require("../services/auditLog");

const UNAUTHORIZED = { error: "Unauthorized" };

async function authenticate(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    await logSecurityEvent("auth_rejected", { ip: req.ip, metadata: { reason: "missing_token" } });
    return res.status(401).json(UNAUTHORIZED);
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    await logSecurityEvent("auth_rejected", {
      ip: req.ip,
      metadata: { reason: err.name === "TokenExpiredError" ? "expired_token" : "invalid_token" },
    });
    return res.status(401).json(UNAUTHORIZED);
  }

  try {
    const result = await client.query("SELECT id, email, role FROM users WHERE id = $1", [payload.id]);
    const user = result.rows[0];

    if (!user) {
      await logSecurityEvent("auth_rejected", {
        ip: req.ip,
        metadata: { reason: "deleted_user", tokenUserId: payload.id },
      });
      return res.status(401).json(UNAUTHORIZED);
    }

    req.user = user;
    next();
  } catch (err) {
    console.error("authenticate() lookup failed:", err);
    res.status(401).json(UNAUTHORIZED);
  }
}

module.exports = { authenticate };
