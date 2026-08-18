/*
  invitations.js — Teams MVP. Token generation/validation/acceptance,
  kept separate from the route file (small-modules precedent, same split
  as videoConversion.js/videoProcessing.js).

  Tokens: crypto.randomBytes(32).toString("hex") — unguessable, generated
  once, returned to the caller exactly once (the route response /
  outgoing email), never stored raw. Only a sha256 hash is persisted, so
  a database read alone can never reveal a usable token — the same
  discipline as password hashing.
*/

const crypto = require("crypto");

const client = require("../db/client");

const DEFAULT_ALLOWED_ORIGIN = "https://cresamorfilmroom-3.onrender.com";
const BASE_URL = process.env.ALLOWED_ORIGIN || DEFAULT_ALLOWED_ORIGIN;

const INVITATION_EXPIRY_DAYS = Number(process.env.INVITATION_EXPIRY_DAYS) || 14;

function hashToken(rawToken) {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

function generateRawToken() {
  return crypto.randomBytes(32).toString("hex");
}

// "store a normalized destination for tracking, such as lowercase email
// or normalized phone number" — email: trim + lowercase. Phone: strip
// everything but digits and a leading +, so "(555) 123-4567" and
// "555-123-4567" land on the same normalized value for tracking/superseding.
function normalizeDestination(destinationType, destination) {
  const trimmed = String(destination || "").trim();

  if (destinationType === "email") {
    return trimmed.toLowerCase();
  }

  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/[^0-9]/g, "");
  return hasPlus ? `+${digits}` : digits;
}

function inviteUrlFor(rawToken) {
  return `${BASE_URL}/?invite=${rawToken}`;
}

// Generates a fresh invitation and supersedes any prior PENDING
// invitation for the exact same (team, destination, role) combination —
// the safer of the two behaviors the spec allows for repeated invites,
// so there's never more than one simultaneously-valid link for the same
// person/team/role at a time. A coach can still send unlimited NEW
// invitations to the same destination; each just invalidates the last.
async function createInvitation({ teamId, invitedBy, roleOnTeam, destinationType, destination }) {
  const normalizedDestination = normalizeDestination(destinationType, destination);
  const rawToken = generateRawToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + INVITATION_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  await client.query(
    `
    UPDATE invitations
    SET status = 'revoked'
    WHERE team_id = $1 AND destination = $2 AND role_on_team = $3 AND status = 'pending'
    `,
    [teamId, normalizedDestination, roleOnTeam]
  );

  const result = await client.query(
    `
    INSERT INTO invitations (team_id, invited_by, role_on_team, destination_type, destination, token_hash, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *
    `,
    [teamId, invitedBy, roleOnTeam, destinationType, normalizedDestination, tokenHash, expiresAt]
  );

  return { invitation: result.rows[0], rawToken, inviteUrl: inviteUrlFor(rawToken) };
}

// Public preview (no auth) — must work before the invitee has logged in
// or even has an account. Returns null for anything invalid/expired/used
// so the route can map that to a single plain 404, not leak which
// specific thing was wrong with the token.
async function getInvitationPreview(rawToken) {
  if (!rawToken) return null;

  const tokenHash = hashToken(rawToken);

  const result = await client.query(
    `
    SELECT invitations.role_on_team, invitations.expires_at,
           teams.id AS team_id, teams.name AS team_name,
           users.display_name AS coach_name, users.email AS coach_email
    FROM invitations
    JOIN teams ON teams.id = invitations.team_id
    JOIN users ON users.id = invitations.invited_by
    WHERE invitations.token_hash = $1
      AND invitations.status = 'pending'
      AND invitations.expires_at > now()
    `,
    [tokenHash]
  );

  return result.rows[0] || null;
}

// The server-side token record is the sole source of truth — this
// function re-validates from scratch (never trusts anything about the
// token except what this query itself proves), so a tampered team id,
// role, or invitation payload in a client request can't bypass it: the
// team/role actually granted always come from THIS row, never from the
// request body.
//
// Beta permissions incident fix: this used to accept purely on token
// possession, with no check that the AUTHENTICATED caller was actually
// the invitation's intended recipient. A coach opening an invite link
// meant for a different email while still logged into their own Coach
// session got THEIR OWN team_members row silently overwritten with the
// invitation's (necessarily lower) role via the ON CONFLICT branch below
// — confirmed via direct reproduction and repaired in production
// (team_members.id=105). Two fixes: (1) for email invitations, the
// authenticated user's own email (server-derived, never client-claimed)
// must match invitation.destination or nothing is mutated at all — phone
// invitations have no comparable identity to check (users has no phone
// column) and fall through to fix (2) as their only protection; (2) an
// invitation can never grant 'coach' (invitations.role_on_team's CHECK
// constraint excludes it), so an ACTIVE existing coach row is never
// overwritten by accepting one — only revoked_at IS NULL counts as
// active; a previously-revoked coach membership still reactivates at the
// invitation's (lower) role exactly as before, since a revoked row may
// have been intentionally revoked and silently restoring Coach authority
// would be its own privilege bug.
//
// Idempotent: ON CONFLICT (team_id, user_id) DO UPDATE means accepting
// the same (or a different, later) invitation for a team the user is
// already active on just confirms/updates the existing row — never a
// duplicate — and also reactivates a previously-revoked membership
// (revoked_at/revoked_by reset to NULL) rather than erroring.
//
// Wrapped in a real transaction (same BEGIN/COMMIT/ROLLBACK pattern as
// videos.js's DELETE route) so the membership write and the invitation's
// accepted-status write can never partially apply; FOR UPDATE closes a
// small pre-existing race where two concurrent accepts for the same
// team/user could interleave their reads.
async function acceptInvitation(rawToken, authenticatedUser) {
  const tokenHash = hashToken(rawToken);

  const invitationResult = await client.query(
    `
    SELECT * FROM invitations
    WHERE token_hash = $1 AND status = 'pending' AND expires_at > now()
    `,
    [tokenHash]
  );

  const invitation = invitationResult.rows[0];
  if (!invitation) return { outcome: "invalid_or_expired" };

  if (invitation.destination_type === "email") {
    const normalizedUserEmail = String(authenticatedUser.email || "").trim().toLowerCase();
    if (normalizedUserEmail !== invitation.destination) {
      return { outcome: "account_mismatch", invitedDestination: invitation.destination };
    }
  }

  const conn = await client.connect();
  try {
    await conn.query("BEGIN");

    const existing = await conn.query(
      `SELECT * FROM team_members WHERE team_id = $1 AND user_id = $2 FOR UPDATE`,
      [invitation.team_id, authenticatedUser.id]
    );
    const existingRow = existing.rows[0];
    const alreadyMember = Boolean(existingRow) && existingRow.revoked_at === null;
    const preserveCoach =
      Boolean(existingRow) && existingRow.role_on_team === "coach" && existingRow.revoked_at === null;

    const teamMemberResult = preserveCoach
      ? { rows: [existingRow] }
      : await conn.query(
          `
          INSERT INTO team_members (team_id, user_id, role_on_team, is_primary)
          VALUES ($1, $2, $3, true)
          ON CONFLICT (team_id, user_id) DO UPDATE
            SET role_on_team = EXCLUDED.role_on_team, revoked_at = NULL, revoked_by = NULL
          RETURNING *
          `,
          [invitation.team_id, authenticatedUser.id, invitation.role_on_team]
        );

    await conn.query(
      `UPDATE invitations SET status = 'accepted', accepted_at = now(), accepted_by = $1 WHERE id = $2`,
      [authenticatedUser.id, invitation.id]
    );

    await conn.query("COMMIT");

    const teamResult = await client.query(`SELECT * FROM teams WHERE id = $1`, [invitation.team_id]);

    return {
      outcome: "accepted",
      team: teamResult.rows[0],
      teamMember: teamMemberResult.rows[0],
      alreadyMember,
      preservedExistingCoachRole: preserveCoach,
    };
  } catch (txError) {
    await conn.query("ROLLBACK");
    throw txError;
  } finally {
    conn.release();
  }
}

module.exports = {
  createInvitation,
  getInvitationPreview,
  acceptInvitation,
  normalizeDestination,
  inviteUrlFor,
};
