const express = require("express");

const client = require("../db/client");
const { authenticate } = require("../middleware/authenticate");
const { requireRole } = require("../middleware/authorize");
const { canManageTeamMembership, canAccessTeam } = require("../services/permissions");
const { logSecurityEvent } = require("../services/auditLog");

const router = express.Router();

/* Foundation Sprint Phase 1: replaces the free-text users.team column and
   capture.js's MOCK_TEAMS with a real Organization -> School -> Team
   hierarchy. Organizations don't have their own endpoint yet — nothing
   client-side needs to query them standalone (see the Phase 1 report). */

router.get("/api/schools", authenticate, async (req, res) => {
  try {
    const result = await client.query(
      `
      SELECT schools.*, organizations.name AS organization_name
      FROM schools
      JOIN organizations ON organizations.id = schools.organization_id
      ORDER BY schools.name
      `
    );

    res.json(result.rows);
  } catch (err) {
    console.error("GET /api/schools error:", err);
    res.status(500).json({ error: "Failed to fetch schools" });
  }
});

router.get("/api/teams", authenticate, async (req, res) => {
  try {
    const result = await client.query(
      `
      SELECT teams.*, schools.name AS school_name
      FROM teams
      LEFT JOIN schools ON schools.id = teams.school_id
      ORDER BY teams.name
      `
    );

    res.json(result.rows);
  } catch (err) {
    console.error("GET /api/teams error:", err);
    res.status(500).json({ error: "Failed to fetch teams" });
  }
});

// Teams MVP: auto-joins the creating coach as an active team_members row
// (role_on_team='coach') — didn't happen before this feature. Without it
// a coach couldn't manage (invite to / revoke members from) the very
// team they just created, since canManageTeam requires a real, active
// team_members row with role_on_team='coach', not just users.role==='coach'.
router.post("/api/teams", authenticate, requireRole("coach"), async (req, res) => {
  try {
    const { name, sport, school_id } = req.body;

    if (!name) {
      return res.status(400).json({ error: "Team name is required" });
    }

    const result = await client.query(
      `
      INSERT INTO teams (name, sport, school_id)
      VALUES ($1, $2, $3)
      RETURNING *
      `,
      [name, sport || null, school_id || null]
    );

    const team = result.rows[0];

    await client.query(
      `
      INSERT INTO team_members (team_id, user_id, role_on_team, is_primary)
      VALUES ($1, $2, 'coach', true)
      ON CONFLICT (team_id, user_id) DO UPDATE
        SET role_on_team = 'coach', revoked_at = NULL, revoked_by = NULL
      `,
      [team.id, req.user.id]
    );

    res.status(201).json(team);
  } catch (err) {
    console.error("POST /api/teams error:", err);
    res.status(500).json({ error: "Failed to create team" });
  }
});

// Teams MVP: team detail — name/sport/school plus an active member count.
// Read access follows canAccessTeam (member-or-any-coach), same as the
// roster below — management actions (invite/revoke) are gated by the
// narrower canManageTeam instead, in routes/invitations.js.
router.get("/api/teams/:id", authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    if (!(await canAccessTeam(req.user.id, id))) {
      return res.status(403).json({ error: "Not authorized to view this team" });
    }

    const result = await client.query(
      `
      SELECT teams.*, schools.name AS school_name,
        (SELECT COUNT(*) FROM team_members WHERE team_members.team_id = teams.id AND team_members.revoked_at IS NULL) AS member_count
      FROM teams
      LEFT JOIN schools ON schools.id = teams.school_id
      WHERE teams.id = $1
      `,
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Team not found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("GET /api/teams/:id error:", err);
    res.status(500).json({ error: "Failed to fetch team" });
  }
});

// Teams MVP: active roster only (revoked_at IS NULL) — a revoked member
// disappears from here immediately, matching "Revoking access should...
// immediately block future team film and team-page access."
router.get("/api/teams/:id/members", authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    if (!(await canAccessTeam(req.user.id, id))) {
      return res.status(403).json({ error: "Not authorized to view this team's roster" });
    }

    const result = await client.query(
      `
      SELECT users.id, users.display_name, users.email, team_members.role_on_team, team_members.created_at AS joined_at
      FROM team_members
      JOIN users ON users.id = team_members.user_id
      WHERE team_members.team_id = $1 AND team_members.revoked_at IS NULL
      ORDER BY team_members.role_on_team, users.display_name
      `,
      [id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("GET /api/teams/:id/members error:", err);
    res.status(500).json({ error: "Failed to fetch team roster" });
  }
});

router.get("/api/users/:id/teams", authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await client.query(
      `
      SELECT teams.*, team_members.role_on_team, team_members.is_primary,
        (SELECT COUNT(*) FROM team_members tm2 WHERE tm2.team_id = teams.id AND tm2.revoked_at IS NULL) AS member_count
      FROM team_members
      JOIN teams ON teams.id = team_members.team_id
      WHERE team_members.user_id = $1 AND team_members.revoked_at IS NULL
      ORDER BY team_members.is_primary DESC, teams.name
      `,
      [id]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("GET /api/users/:id/teams error:", err);
    res.status(500).json({ error: "Failed to fetch user's teams" });
  }
});

// Beta Readiness Sprint 2 bug fix: this used to have NO authorization
// check at all — any caller could set role_on_team to "coach" for any
// user on any team. Now: a coach may manage anyone's membership
// (including granting a coach-level role); a non-coach may only add
// THEMSELVES, and only with a non-coach role_on_team.
router.post("/api/users/:id/teams", authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { team_id, role_on_team, is_primary } = req.body;

    if (!team_id) {
      return res.status(400).json({ error: "team_id is required" });
    }

    if (!(await canManageTeamMembership(req.user.id, id, role_on_team))) {
      return res.status(403).json({ error: "Not authorized to manage this team membership" });
    }

    const result = await client.query(
      `
      INSERT INTO team_members (team_id, user_id, role_on_team, is_primary)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (team_id, user_id) DO UPDATE
        SET role_on_team = EXCLUDED.role_on_team, is_primary = EXCLUDED.is_primary
      RETURNING *
      `,
      [team_id, id, role_on_team || null, is_primary !== undefined ? is_primary : true]
    );

    await logSecurityEvent("team_membership_changed", {
      userId: req.user.id,
      ip: req.ip,
      metadata: { targetUserId: Number(id), teamId: Number(team_id), roleOnTeam: role_on_team || null },
    });

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("POST /api/users/:id/teams error:", err);
    res.status(500).json({ error: "Failed to join team" });
  }
});

module.exports = router;
