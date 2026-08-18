/*
  invitations.js (routes) — Teams MVP. Same shape as teams.js/conversations.js:
  a self-contained express.Router() declaring full /api/... paths.

  GET /api/invitations/:token is deliberately the only route in this file
  without `authenticate` — it must work for someone who isn't logged in
  yet (existing-logged-out and brand-new-user cases both need to see
  "you've been invited to join X as Y" before they can log in/register).
  Every other route requires a real session.
*/

const express = require("express");

const client = require("../db/client");
const { authenticate } = require("../middleware/authenticate");
const { canManageTeam } = require("../services/permissions");
const { createInvitation, getInvitationPreview, acceptInvitation } = require("../services/invitations");
const { sendEmail } = require("../services/email");
const { logSecurityEvent } = require("../services/auditLog");

const router = express.Router();

const VALID_ROLES = ["athlete", "parent", "assistant_coach"];
const ROLE_LABELS = { athlete: "Athlete", parent: "Parent", assistant_coach: "Assistant Coach" };

router.post("/api/teams/:teamId/invitations", authenticate, async (req, res) => {
  try {
    const { teamId } = req.params;
    const { destinationType, destination, roleOnTeam } = req.body;

    if (!destinationType || !["email", "phone"].includes(destinationType)) {
      return res.status(400).json({ error: "destinationType must be 'email' or 'phone'" });
    }
    if (!destination) {
      return res.status(400).json({ error: "destination is required" });
    }
    if (!roleOnTeam || !VALID_ROLES.includes(roleOnTeam)) {
      return res.status(400).json({ error: "roleOnTeam must be one of: " + VALID_ROLES.join(", ") });
    }

    if (!(await canManageTeam(req.user.id, teamId))) {
      return res.status(403).json({ error: "Not authorized to invite members to this team" });
    }

    const teamResult = await client.query("SELECT * FROM teams WHERE id = $1", [teamId]);
    const team = teamResult.rows[0];
    if (!team) {
      return res.status(404).json({ error: "Team not found" });
    }

    const { invitation, inviteUrl } = await createInvitation({
      teamId,
      invitedBy: req.user.id,
      roleOnTeam,
      destinationType,
      destination,
    });

    let emailResult = { sent: false, reason: "not_email" };
    if (destinationType === "email") {
      emailResult = await sendEmail({
        to: invitation.destination,
        subject: `You're invited to join ${team.name} on Cresamor`,
        html: `<p>${req.user.email} has invited you to join <strong>${team.name}</strong> as ${ROLE_LABELS[roleOnTeam]} on Cresamor Film Room.</p><p><a href="${inviteUrl}">Accept invitation</a></p><p>This link expires in a few days and can only be used once.</p>`,
        text: `You've been invited to join ${team.name} as ${ROLE_LABELS[roleOnTeam]} on Cresamor Film Room. Accept: ${inviteUrl}`,
      });
    }

    await logSecurityEvent("invitation_created", {
      userId: req.user.id,
      ip: req.ip,
      metadata: { teamId: Number(teamId), destinationType, roleOnTeam },
    });

    res.status(201).json({
      id: invitation.id,
      teamId: invitation.team_id,
      roleOnTeam: invitation.role_on_team,
      destinationType: invitation.destination_type,
      destination: invitation.destination,
      expiresAt: invitation.expires_at,
      inviteUrl,
      emailSent: emailResult.sent,
    });
  } catch (err) {
    console.error("POST /api/teams/:teamId/invitations error:", err);
    res.status(500).json({ error: "Failed to create invitation" });
  }
});

router.get("/api/teams/:teamId/invitations", authenticate, async (req, res) => {
  try {
    const { teamId } = req.params;

    if (!(await canManageTeam(req.user.id, teamId))) {
      return res.status(403).json({ error: "Not authorized to view invitations for this team" });
    }

    const result = await client.query(
      `
      SELECT id, role_on_team, destination_type, destination, status, created_at, expires_at
      FROM invitations
      WHERE team_id = $1
      ORDER BY created_at DESC
      `,
      [teamId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("GET /api/teams/:teamId/invitations error:", err);
    res.status(500).json({ error: "Failed to fetch invitations" });
  }
});

// Deliberately public — see file header.
router.get("/api/invitations/:token", async (req, res) => {
  try {
    const preview = await getInvitationPreview(req.params.token);

    if (!preview) {
      return res.status(404).json({
        error: "This invitation link has expired or already been used. Ask your coach to send a new one.",
      });
    }

    res.json({
      teamId: preview.team_id,
      teamName: preview.team_name,
      coachName: preview.coach_name || preview.coach_email,
      roleOnTeam: preview.role_on_team,
      roleLabel: ROLE_LABELS[preview.role_on_team] || preview.role_on_team,
      expiresAt: preview.expires_at,
    });
  } catch (err) {
    console.error("GET /api/invitations/:token error:", err);
    res.status(500).json({ error: "Failed to look up invitation" });
  }
});

router.post("/api/invitations/:token/accept", authenticate, async (req, res) => {
  try {
    const result = await acceptInvitation(req.params.token, req.user);

    if (result.outcome === "invalid_or_expired") {
      return res.status(404).json({
        error: "This invitation link has expired or already been used. Ask your coach to send a new one.",
      });
    }

    // Beta permissions incident fix: distinct 409 (not 404) so the client
    // can tell "wrong account currently signed in" apart from "this link
    // is dead" — mutates nothing (see acceptInvitation()).
    if (result.outcome === "account_mismatch") {
      return res.status(409).json({
        error: "account_mismatch",
        invitedDestination: result.invitedDestination,
      });
    }

    await logSecurityEvent("invitation_accepted", {
      userId: req.user.id,
      ip: req.ip,
      metadata: { teamId: result.team.id, preservedExistingCoachRole: result.preservedExistingCoachRole },
    });

    res.json({
      team: { id: result.team.id, name: result.team.name },
      roleOnTeam: result.teamMember.role_on_team,
      alreadyMember: result.alreadyMember,
      preservedExistingCoachRole: result.preservedExistingCoachRole,
    });
  } catch (err) {
    console.error("POST /api/invitations/:token/accept error:", err);
    res.status(500).json({ error: "Failed to accept invitation" });
  }
});

// Soft-disable, never a hard delete — the account and its personal data
// are preserved; only the team_members row is marked revoked so
// canAccessTeam (and everything gated by it, including Team Film) stops
// counting it as active membership immediately.
router.delete("/api/teams/:teamId/members/:userId", authenticate, async (req, res) => {
  try {
    const { teamId, userId } = req.params;

    if (!(await canManageTeam(req.user.id, teamId))) {
      return res.status(403).json({ error: "Not authorized to manage members of this team" });
    }

    const result = await client.query(
      `
      UPDATE team_members
      SET revoked_at = now(), revoked_by = $1
      WHERE team_id = $2 AND user_id = $3 AND revoked_at IS NULL
      RETURNING *
      `,
      [req.user.id, teamId, userId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Active membership not found" });
    }

    await logSecurityEvent("team_member_revoked", {
      userId: req.user.id,
      ip: req.ip,
      metadata: { teamId: Number(teamId), targetUserId: Number(userId) },
    });

    res.json({ success: true, teamId: Number(teamId), userId: Number(userId) });
  } catch (err) {
    console.error("DELETE /api/teams/:teamId/members/:userId error:", err);
    res.status(500).json({ error: "Failed to remove member" });
  }
});

module.exports = router;
