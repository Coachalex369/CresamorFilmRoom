/*
  messageLabels.js — the one place a message's sender label is computed,
  for both Team Chat and Direct Messaging (they share the exact same
  POST /api/conversations/:id/messages route -- see conversations.js --
  so there was never a second write path to independently drift from).

  Production bug fix: the write path used to store `display_name ||
  email` as a message's permanent `username`. display_name is optional
  and unset for most real accounts (20 of 26 real users at the time this
  was found), so a real user's real email address was being permanently
  stored and shown to every OTHER participant in that conversation --
  confirmed in production: at least 3 real messages already had this
  happen before this fix. A message's sender identity is fundamentally
  different from e.g. a profile page: it's shown to everyone else in the
  thread, not just the account owner or someone the owner explicitly
  granted access to.

  Never falls back to email or phone -- a role-aware label instead
  (Coach/Assistant Coach/Athlete/Parent/Team Member). This is genuinely
  never sensitive: role is already visible everywhere else a
  conversation's other_participant is shown (see permissions.js's
  getEligibleRecipients and conversations.js's GET /api/conversations).
*/

const client = require("../db/client");

const ROLE_SENDER_LABELS = {
  coach: "Coach",
  assistant_coach: "Assistant Coach",
  athlete: "Athlete",
  parent: "Parent",
};

function safeSenderLabel({ display_name, role }) {
  if (display_name) return display_name;
  return ROLE_SENDER_LABELS[role] || "Team Member";
}

// Deliberately simple (contains an @ with something on both sides) --
// this only needs to catch genuine email addresses stored by the old
// buggy write path, not validate arbitrary input.
function looksLikeEmail(value) {
  return typeof value === "string" && /^\S+@\S+\.\S+$/.test(value.trim());
}

// Defensive read-time sanitizer: a message's stored `username` is fixed
// at send time and normally already safe now that the write path above
// is fixed -- but rows written before this fix genuinely have a real
// email sitting in that column right now, and won't be safe to serve
// until (a) this sanitizer runs on every read, independent of whether/
// when a backfill migration is ever run, and (b) as defense in depth
// even after a backfill, in case any other write path is ever added
// without going through safeSenderLabel(). Re-derives from the sender's
// CURRENT display_name/role rather than trusting the stored value at all
// for any row that still looks like an email. Batches one query for
// every affected sender rather than one per row.
async function sanitizeMessageRows(rows) {
  const emailish = rows.filter((row) => looksLikeEmail(row.username));
  if (!emailish.length) return rows;

  const senderIds = [...new Set(emailish.map((row) => row.sender_id))];
  const usersResult = await client.query("SELECT id, display_name, role FROM users WHERE id = ANY($1::int[])", [
    senderIds,
  ]);
  const byId = new Map(usersResult.rows.map((u) => [u.id, u]));

  return rows.map((row) => {
    if (!looksLikeEmail(row.username)) return row;
    const sender = byId.get(row.sender_id);
    return { ...row, username: sender ? safeSenderLabel(sender) : "Team Member" };
  });
}

module.exports = { safeSenderLabel, looksLikeEmail, sanitizeMessageRows };
