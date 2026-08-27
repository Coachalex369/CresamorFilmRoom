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

// Messages team-scoping fix: a category='team' conversation's
// authorization is derived LIVE from active team_members, not from the
// conversation_participants table -- that table is retained only for
// last_read_at/unread bookkeeping now, never the access boundary for a
// team conversation. This is what makes team revocation instantly cut
// off message GET/POST access, the same guarantee canAccessTeam already
// provides everywhere else in the app; a stale or missing
// conversation_participants row can no longer leak access to a former
// member OR incorrectly block a current one.
//
// Deliberately gated on category === 'team' specifically, not merely
// "team_id is non-null" -- a future coach/parent/athlete/direct
// conversation may carry a team_id purely for context (e.g. "this is a
// parent thread about a player on Team X") without meaning every member
// of Team X should see it. Only the real team-wide conversation gets the
// broad team-membership check; every other category keeps the original,
// narrower participant-row model regardless of what team_id it carries.
async function canAccessConversation(userId, conversationId) {
  if (!userId || !conversationId) return false;

  const conversationResult = await client.query(
    `SELECT team_id, category FROM conversations WHERE id = $1`,
    [conversationId]
  );
  const conversation = conversationResult.rows[0];
  if (!conversation) return false;

  if (conversation.category === "team" && conversation.team_id !== null) {
    return canAccessTeam(userId, conversation.team_id);
  }

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

// Beta permissions audit fix: this used to be "the original uploader, or
// ANY user with the global users.role='coach'" — which let a coach
// managing Team A delete (or force-reprocess, via retry-conversion/
// retry-classification, which both reuse this same check) a video
// belonging to a completely unrelated Team B, just by knowing/guessing
// its numeric id. Team-scoped video *visibility* (canViewVideo) already
// doesn't work this way; management shouldn't either. Now: the uploader
// can always manage their own video (unconditional, matching
// canViewVideo's existing unconditional uploader check); for an
// assigned video (team_id NOT NULL), management requires real per-team
// authority via canManageTeam — global coach role alone is no longer
// sufficient; for an unassigned video (team_id NULL), the rule is
// unchanged from before (any global coach can still manage it) —
// deliberately mirroring canViewVideo's own team_id===null branch, since
// there's no team boundary to scope against yet and this is the exact
// mechanism a coach already relies on to clean up / Change-Team an
// unassigned upload today.
async function canDeleteVideo(userId, videoId) {
  if (!userId || !videoId) return false;

  const result = await client.query(
    `
    SELECT videos.uploaded_by, videos.team_id, users.role
    FROM videos, users
    WHERE videos.id = $1 AND users.id = $2
    `,
    [videoId, userId]
  );

  if (!result.rows.length) return false;

  const { uploaded_by, team_id, role } = result.rows[0];

  if (Number(uploaded_by) === Number(userId)) return true;

  if (team_id === null) return role === "coach";

  return canManageTeam(userId, team_id);
}

// Closed Beta Readiness Sprint: team-scoped access requires a real,
// active team_members row — the former "any coach can access any team"
// blanket shortcut was removed. An unrelated coach must not see another
// team's private roster or Team Film merely because their global
// users.role is 'coach'; only a genuine (non-revoked) membership counts,
// same rule for every role. See canManageTeam below for the (already
// narrower, already membership-scoped) management-action check.
async function canAccessTeam(userId, teamId) {
  if (!userId || !teamId) return false;

  const result = await client.query(
    `
    SELECT 1
    FROM team_members
    WHERE user_id = $1 AND team_id = $2 AND revoked_at IS NULL
    `,
    [userId, teamId]
  );

  return result.rows.length > 0;
}

// Teams MVP: gates team-MANAGEMENT actions (create invitation, revoke a
// member). "Coaches may manage only teams assigned to them" means an
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
// canAccessTeam (active membership required) — reused directly rather
// than duplicated, since viewing the roster is a read, not a management
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

// Resumable-uploads sprint: gates POST /api/video-uploads/initiate when a
// team_id is supplied. Deliberately its own function, not canManageTeam --
// canManageTeam is coach-only (event/roster management), but Assistant
// Coach is meant to be able to add Film Room content too, just not manage
// the team itself. Explicitly excludes 'parent' and 'athlete'
// role_on_team: an unrelated user can't target another team's Film Room
// just by knowing/guessing its numeric id (the vulnerability this
// replaces -- the legacy POST /api/upload-video route still accepts any
// team_id with no check at all, preserved there for parity, not fixed as
// a side effect of this feature), and a parent's relationship to a team is
// deliberately not upload authority here -- a parent-facing "Team
// Highlights" upload destination is a real future product surface, not
// something this authorization fix builds out.
async function canUploadToTeam(userId, teamId) {
  if (!userId || !teamId) return false;

  const result = await client.query(
    `
    SELECT 1
    FROM team_members
    WHERE user_id = $1 AND team_id = $2
      AND role_on_team IN ('coach', 'assistant_coach')
      AND revoked_at IS NULL
    `,
    [userId, teamId]
  );

  return result.rows.length > 0;
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
  canUploadToTeam,
};
