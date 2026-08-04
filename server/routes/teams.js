const express = require("express");

const client = require("../db/client");
const { authenticate } = require("../middleware/authenticate");
const { requireRole } = require("../middleware/authorize");
const { canManageTeamMembership } = require("../services/permissions");
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

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("POST /api/teams error:", err);
    res.status(500).json({ error: "Failed to create team" });
  }
});

router.get("/api/users/:id/teams", authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await client.query(
      `
      SELECT teams.*, team_members.role_on_team, team_members.is_primary
      FROM team_members
      JOIN teams ON teams.id = team_members.team_id
      WHERE team_members.user_id = $1
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
