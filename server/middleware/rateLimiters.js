/*
  rateLimiters.js — Beta Readiness Sprint 2. Beta-appropriate, not
  production-hardened: in-memory store (fine for a single Render
  instance), deliberately loose limits, easy to tighten later without an
  architecture change. Applied only to the routes named in the sprint
  plan — login, register, video upload, photo upload.
*/

const rateLimit = require("express-rate-limit");

const { logSecurityEvent } = require("../services/auditLog");

function loggedHandler(eventType) {
  return async (req, res) => {
    await logSecurityEvent(eventType, { ip: req.ip, metadata: { path: req.originalUrl } });
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

// Resumable-uploads sprint: one call to /api/video-uploads/initiate is the
// same "one logical upload" unit as one call to /api/upload-video above --
// same limit/window, just a distinct limiter instance (separate counters)
// so this route's traffic doesn't share a bucket with the legacy route's.
const initiateUploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: loggedHandler("upload_rate_limited"),
});

// Part-presign volume scales with file size (a 4GB file at a 10MB part size
// is ~400 calls), not with "how many uploads" -- a per-upload limit here
// would false-trigger on a single large, healthy upload. Generous enough to
// cover a large upload's parts plus a realistic amount of per-part retry,
// still bounded so a compromised/misbehaving client can't mint unlimited
// signed URLs.
const presignPartLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  handler: loggedHandler("upload_rate_limited"),
});

module.exports = { loginLimiter, registerLimiter, uploadLimiter, initiateUploadLimiter, presignPartLimiter };
