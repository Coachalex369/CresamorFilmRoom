/*
  authorize.js — Beta Readiness Sprint 2. The "what can you do" half of the
  auth split (see authenticate.js for "who are you"). Every export here
  assumes authenticate has already run and set req.user — use as
  authenticate, requireX, handler.

  Declarative where the check is a single binary gate on one resource
  (the majority of this app's routes). Routes whose "authorization" is
  really a per-row filter over a list (GET /api/videos, GET
  /api/conversations) don't use these — they stay behind authenticate
  alone and filter inline using permissions.js, since there's no single
  yes/no gate a middleware could enforce before the handler runs.
*/

const { canAccessConversation } = require("../services/permissions");

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    next();
  };
}

function requireOwner(paramName) {
  return (req, res, next) => {
    if (req.params[paramName] !== String(req.user.id)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    next();
  };
}

function requireConversationParticipant(paramName = "id") {
  return async (req, res, next) => {
    const conversationId = req.params[paramName];

    if (!(await canAccessConversation(req.user.id, conversationId))) {
      return res.status(403).json({ error: "Not a participant of this conversation" });
    }
    next();
  };
}

module.exports = { requireRole, requireOwner, requireConversationParticipant };
