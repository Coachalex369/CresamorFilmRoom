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

module.exports = { logSecurityEvent };
