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
const {
  createInvitation,
  getInvitationPreview,
  acceptInvitation,
  acceptInvitationById,
  getPendingInvitationsForUser,
} = require("../services/invitations");
const { sendEmail } = require("../services/email");
const { logSecurityEvent } = require("../services/auditLog");

const router = express.Router();

const VALID_ROLES = ["athlete", "parent", "assistant_coach", "coach"];
const ROLE_LABELS = { athlete: "Athlete", parent: "Parent", assistant_coach: "Assistant Coach", coach: "Coach" };

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

    // Platform Admin gate: canManageTeam above only proves the caller has
    // SOME coach-level authority on this team -- it does not distinguish a
    // platform admin from an ordinary team coach. A regular coach must not
    // gain the ability to mint other coaches merely by being a coach
    // themselves (that would defeat the point of a separate admin tier),
    // so a Coach-level invitation additionally requires
    // req.user.is_platform_admin, which authenticate.js reloads fresh from
    // Postgres on every request -- never stale, never token-cached.
    if (roleOnTeam === "coach" && !req.user.is_platform_admin) {
      return res.status(403).json({ error: "Only a platform admin can invite a Coach to a team" });
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

// In-app "Pending invitations for you" list -- server-derived email
// only (req.user.email, reloaded fresh from Postgres by authenticate.js
// on every request), never a client-supplied email/query param.
//
// Registered BEFORE GET /api/invitations/:token below: Express matches
// path patterns in registration order, and "/api/invitations/mine" is
// structurally identical to "/api/invitations/:token" (one segment
// after /invitations/) -- if :token were registered first, it would
// greedily match the literal string "mine" as a token value and this
// route would never be reached.
router.get("/api/invitations/mine", authenticate, async (req, res) => {
  try {
    const invitations = await getPendingInvitationsForUser(req.user.email);

    res.json(
      invitations.map((invitation) => ({
        id: invitation.id,
        teamId: invitation.team_id,
        teamName: invitation.team_name,
        coachName: invitation.coach_name || invitation.coach_email,
        roleOnTeam: invitation.role_on_team,
        roleLabel: ROLE_LABELS[invitation.role_on_team] || invitation.role_on_team,
        expiresAt: invitation.expires_at,
      }))
    );
  } catch (err) {
    console.error("GET /api/invitations/mine error:", err);
    res.status(500).json({ error: "Failed to fetch your pending invitations" });
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
      // Only meaningful for email invitations -- null for phone, where
      // there's no comparable identity on users to check against.
      accountExists: preview.destination_type === "email" ? preview.account_exists : null,
    });
  } catch (err) {
    console.error("GET /api/invitations/:token error:", err);
    res.status(500).json({ error: "Failed to look up invitation" });
  }
});

// Shared by both accept routes below (token-based and id-based) -- one
// place mapping applyInvitation's outcome to an HTTP response, so the
// in-app "Pending invitations for you" accept path can't drift from the
// emailed-link accept path's behavior.
async function respondToAcceptOutcome(req, res, result) {
  if (result.outcome === "invalid_or_expired") {
    return res.status(404).json({
      error: "This invitation link has expired or already been used. Ask your coach to send a new one.",
    });
  }

  // Beta permissions incident fix: distinct 409 (not 404) so the client
  // can tell "wrong account currently signed in" apart from "this link
  // is dead" — mutates nothing (see applyInvitation()).
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
}

router.post("/api/invitations/:token/accept", authenticate, async (req, res) => {
  try {
    const result = await acceptInvitation(req.params.token, req.user);
    await respondToAcceptOutcome(req, res, result);
  } catch (err) {
    console.error("POST /api/invitations/:token/accept error:", err);
    res.status(500).json({ error: "Failed to accept invitation" });
  }
});

// Accepts by numeric id -- the in-app "Pending invitations for you" list
// never has the raw token (it was never persisted, see
// services/invitations.js's file header), so it can't use the
// token-based route above. Same authorization/outcome handling either
// way (respondToAcceptOutcome, applyInvitation).
//
// Deliberately "/by-id/:id/accept", not "/:id/accept" -- the latter is
// structurally identical to "/:token/accept" above (one param segment
// then /accept) and would either be shadowed by it or shadow it
// depending on registration order. The extra /by-id/ segment makes this
// four segments long (never colliding with any three-segment
// invitations route regardless of registration order) and names what
// actually distinguishes this route from the one above: it looks up by
// numeric id, not by raw token.
router.post("/api/invitations/by-id/:id/accept", authenticate, async (req, res) => {
  try {
    const invitationId = Number(req.params.id);
    if (!Number.isInteger(invitationId) || invitationId <= 0) {
      return res.status(400).json({ error: "Invalid invitation id" });
    }

    const result = await acceptInvitationById(invitationId, req.user);
    await respondToAcceptOutcome(req, res, result);
  } catch (err) {
    console.error("POST /api/invitations/by-id/:id/accept error:", err);
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

    // Platform-admin hand-off safety net: a coach removing their OWN
    // coach-level membership must never leave a team with zero active
    // coaches -- most relevant here since it's exactly what a platform
    // admin does after handing a beta team off to its real Coach, but
    // written as a general guard (not admin-specific) since the failure
    // mode it prevents (a team nobody can manage) is bad regardless of who
    // triggers it.
    if (Number(userId) === Number(req.user.id)) {
      const selfRow = await client.query(
        `SELECT role_on_team FROM team_members WHERE team_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [teamId, userId]
      );

      if (selfRow.rows[0]?.role_on_team === "coach") {
        const otherActiveCoach = await client.query(
          `
          SELECT 1 FROM team_members
          WHERE team_id = $1 AND user_id != $2 AND role_on_team = 'coach' AND revoked_at IS NULL
          `,
          [teamId, userId]
        );

        if (!otherActiveCoach.rows.length) {
          return res.status(400).json({
            error:
              "Cannot remove yourself — this team would be left with no active Coach. Confirm another Coach is active on the team first.",
          });
        }
      }
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
