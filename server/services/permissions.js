/*
  permissions.js — permission groundwork (Foundation Sprint Phase 2),
  extended in Beta Readiness Sprint 2 (server-side auth). Every function
  here now runs against req.user.id, supplied by middleware/authenticate.js
  after verifying a JWT — not a client-claimed body/query field anymore.

  As the Organization -> School -> Team hierarchy grows, extend this file
  with more resource-specific checks rather than scattering ad-hoc
  permission queries through the route files.
*/

const client = require("../db/client");

async function canAccessConversation(userId, conversationId) {
  if (!userId || !conversationId) return false;

  const result = await client.query(
    `
    SELECT 1
    FROM conversation_participants
    WHERE user_id = $1 AND conversation_id = $2
    `,
    [userId, conversationId]
  );

  return result.rows.length > 0;
}

// Real rule: the original uploader, or anyone with the 'coach' role, can
// delete a video.
async function canDeleteVideo(userId, videoId) {
  if (!userId || !videoId) return false;

  const result = await client.query(
    `
    SELECT videos.uploaded_by, users.role
    FROM videos, users
    WHERE videos.id = $1 AND users.id = $2
    `,
    [videoId, userId]
  );

  if (!result.rows.length) return false;

  const { uploaded_by, role } = result.rows[0];

  return role === "coach" || Number(uploaded_by) === Number(userId);
}

// Coach access is a superset everywhere in this app — a coach can access
// any team without needing an explicit team_members row. A revoked
// membership (revoked_at IS NOT NULL) does not count as membership for a
// non-coach — see Teams MVP's revoke-access feature.
async function canAccessTeam(userId, teamId) {
  if (!userId || !teamId) return false;

  const result = await client.query(
    `
    SELECT users.role, team_members.team_id AS membership_team_id
    FROM users
    LEFT JOIN team_members
      ON team_members.user_id = users.id
      AND team_members.team_id = $2
      AND team_members.revoked_at IS NULL
    WHERE users.id = $1
    `,
    [userId, teamId]
  );

  if (!result.rows.length) return false;

  const { role, membership_team_id } = result.rows[0];

  return role === "coach" || membership_team_id !== null;
}

// Teams MVP: gates team-MANAGEMENT actions (create invitation, revoke a
// member) — deliberately narrower than canAccessTeam's blanket
// any-coach-sees-every-team rule above, which stays unchanged for
// viewing. "Coaches may manage only teams assigned to them" means an
// active team_members row on THAT team with role_on_team = 'coach', not
// just users.role === 'coach' in general. POST /api/teams auto-inserts
// this row for the creator, so a coach can always manage a team they
// just created.
async function canManageTeam(userId, teamId) {
  if (!userId || !teamId) return false;

  const result = await client.query(
    `
    SELECT 1
    FROM team_members
    WHERE user_id = $1 AND team_id = $2 AND role_on_team = 'coach' AND revoked_at IS NULL
    `,
    [userId, teamId]
  );

  return result.rows.length > 0;
}

// Teams MVP: the roster/team-detail read path. Same access shape as
// canAccessTeam (member-or-any-coach) — reused directly rather than
// duplicated, since viewing the roster is a read, not a management
// action (that's canManageTeam above).
async function canViewTeamRoster(userId, teamId) {
  return canAccessTeam(userId, teamId);
}

// Production bug fix: the uploader must always be able to see their own
// video, regardless of team_id — matching canDeleteVideo's existing
// unconditional uploader check. This was previously only granted in the
// team_id === null branch, so a non-coach who tagged a recording with a
// team they aren't actually a team_members row for (the capture.js team
// picker doesn't verify membership before offering a team) lost
// visibility into their OWN upload — GET /api/videos/:id even 403'd for
// its own uploader. video.team_id === null is the "unassigned" case (see
// videos.js's upload route) — visible to the uploader (below) or a coach,
// since there's no team to scope it to. Otherwise, visibility follows
// team membership for everyone except the uploader.
async function canViewVideo(userId, video) {
  if (!userId || !video) return false;

  if (Number(video.uploaded_by) === Number(userId)) return true;

  if (video.team_id === null || video.team_id === undefined) {
    const result = await client.query("SELECT role FROM users WHERE id = $1", [userId]);
    return result.rows[0]?.role === "coach";
  }

  return canAccessTeam(userId, video.team_id);
}

// The role-escalation fix for POST /api/users/:id/teams: a coach may set
// any membership, including a coach-level role_on_team, for anyone. A
// non-coach may only add THEMSELVES, and only with a non-coach role.
async function canManageTeamMembership(userId, targetUserId, roleOnTeam) {
  if (!userId) return false;

  const result = await client.query("SELECT role FROM users WHERE id = $1", [userId]);
  const role = result.rows[0]?.role;

  if (role === "coach") return true;

  return Number(userId) === Number(targetUserId) && roleOnTeam !== "coach";
}

module.exports = {
  canAccessConversation,
  canDeleteVideo,
  canAccessTeam,
  canManageTeam,
  canViewTeamRoster,
  canViewVideo,
  canManageTeamMembership,
};
