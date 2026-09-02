/*
  auditLog.js — Beta Readiness Sprint 2. A lightweight, DB-backed security
  audit trail (see migrations/007_security_audit_log.sql). Deliberately one
  function: callers pass an event_type string and whatever non-sensitive
  context is relevant. Never pass a token, password, or password hash in
  metadata — this table is a durable, queryable log, not a scratch pad.

  Callers await this before responding, so an audit entry is guaranteed to
  exist by the time a caller's request finishes — but a logging failure
  must never fail the request it's describing. Errors are caught and
  console.error'd here, never rethrown.
*/

const client = require("../db/client");

async function logSecurityEvent(eventType, { userId = null, ip = null, metadata = {} } = {}) {
  try {
    await client.query(
      `
      INSERT INTO security_audit_log (event_type, user_id, ip_address, metadata)
      VALUES ($1, $2, $3, $4)
      `,
      [eventType, userId, ip, JSON.stringify(metadata)]
    );
  } catch (err) {
    console.error("Failed to write security audit log entry:", eventType, err);
  }
}

// Team Highlights, Slice 1 correction: some legitimate audit events have
// no user_id by nature (a rejected/anonymous request — bad token, rate
// limit, forgot-password for a non-existent email). A production-backed
// test that deliberately triggers these needs to clean up EXACTLY the
// rows it created, by exact id — never a watermark, time range, or
// event-type/IP pattern, since a genuine concurrent anonymous event could
// otherwise be swept up and destroyed. This lets a caller (authenticate.js,
// rateLimiters.js, auth.js's forgot-password route) tag its own metadata
// with a per-run correlation id the test script chooses, so it can query
// its own rows back out afterward and delete precisely those ids.
//
// Gated server-side only: reads process.env.ALLOW_PRODUCTION_TESTS on
// THIS server, never anything the request claims. In real production that
// env var is never "true", so this always returns {} there regardless of
// what any client sends — a request cannot opt itself into anything, and
// nothing about authorization, rate limiting, or the response changes.
// Purely additive metadata for later attribution, nothing else.
function testCorrelationMetadata(req) {
  if (process.env.ALLOW_PRODUCTION_TESTS !== "true") return {};
  const tag = req && req.headers && req.headers["x-test-correlation-id"];
  if (!tag || typeof tag !== "string") return {};
  return { testCorrelationId: tag.slice(0, 100) };
}

module.exports = { logSecurityEvent, testCorrelationMetadata };
