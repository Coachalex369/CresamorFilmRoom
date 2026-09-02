/*
  rateLimiters.js — Beta Readiness Sprint 2. Beta-appropriate, not
  production-hardened: in-memory store (fine for a single Render
  instance), deliberately loose limits, easy to tighten later without an
  architecture change. Applied only to the routes named in the sprint
  plan — login, register, video upload, photo upload.
*/

const rateLimit = require("express-rate-limit");

const { logSecurityEvent, testCorrelationMetadata } = require("../services/auditLog");

function loggedHandler(eventType) {
  return async (req, res) => {
    await logSecurityEvent(eventType, {
      ip: req.ip,
      metadata: { path: req.originalUrl, ...testCorrelationMetadata(req) },
    });
    res.status(429).json({ error: "Too many requests — please try again later" });
  };
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: loggedHandler("login_rate_limited"),
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: loggedHandler("register_rate_limited"),
});

const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: loggedHandler("upload_rate_limited"),
});

module.exports = { loginLimiter, registerLimiter, uploadLimiter };
