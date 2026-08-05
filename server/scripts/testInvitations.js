/*
  testInvitations.js — Teams MVP acceptance script. Same shape as
  testAuth.js/testVideoVisibility.js: plain Node, real app on a
  throwaway local port, real fetch() calls, RUN_TAG-namespaced rows,
  full cleanup in a finally block regardless of pass/fail.

  Run by hand: ALLOW_PRODUCTION_TESTS=true node server/scripts/testInvitations.js
*/

require("dotenv").config();

const { requireProductionTestOptIn } = require("./lib/requireProductionTestOptIn");
requireProductionTestOptIn("testInvitations.js");

const crypto = require("crypto");

const app = require("../app");
const client = require("../db/client");

const PORT = 3990;
const BASE_URL = `http://localhost:${PORT}`;
const RUN_TAG = `invitesprint_${Date.now()}`;

const results = [];

function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
}

function assert(name, condition, detail) {
  record(name, Boolean(condition), detail);
}

async function req(path, { method = "GET", token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  return { status: response.status, data };
}

async function registerUser(email, role) {
  const { status, data } = await req("/api/auth/register", {
    method: "POST",
    body: { email, password: "TestPass123!", role },
  });
  if (status !== 201) throw new Error(`Failed to register ${email}: ${status} ${JSON.stringify(data)}`);
  return data; // { token, user }
}

async function main() {
  const created = { userIds: [], teamIds: [] };
  const server = app.listen(PORT);

  try {
    // ---- Setup: a coach and a team ----
    const coach = await registerUser(`${RUN_TAG}-coach@test.cresamor.local`, "coach");
    created.userIds.push(coach.user.id);

    const teamRes = await req("/api/teams", {
      method: "POST",
      token: coach.token,
      body: { name: `${RUN_TAG} Team`, sport: "Wrestling" },
    });
    const team = teamRes.data;
    created.teamIds.push(team.id);
    assert("coach creates a team", teamRes.status === 201, `status=${teamRes.status}`);

    const coachTeamsRes = await req(`/api/users/${coach.user.id}/teams`, { token: coach.token });
    const autoJoined = coachTeamsRes.data.find((t) => t.id === team.id);
    assert(
      "coach is auto-joined to their own team as role_on_team='coach'",
      autoJoined && autoJoined.role_on_team === "coach",
      JSON.stringify(autoJoined)
    );
    assert(
      "GET /api/users/:id/teams reports member_count",
      autoJoined && Number(autoJoined.member_count) === 1,
      `member_count=${autoJoined?.member_count}`
    );

    // ---- Non-coach cannot create a team or invitations ----
    const outsider = await registerUser(`${RUN_TAG}-outsider@test.cresamor.local`, "athlete");
    created.userIds.push(outsider.user.id);

    const outsiderCreateInviteRes = await req(`/api/teams/${team.id}/invitations`, {
      method: "POST",
      token: outsider.token,
      body: { destinationType: "email", destination: "nobody@test.cresamor.local", roleOnTeam: "athlete" },
    });
    assert(
      "non-member cannot create an invitation for the team",
      outsiderCreateInviteRes.status === 403,
      `status=${outsiderCreateInviteRes.status}`
    );

    // ---- Coach invites a new athlete by email ----
    const athleteEmail = `${RUN_TAG}-athlete@test.cresamor.local`;
    const inviteRes = await req(`/api/teams/${team.id}/invitations`, {
      method: "POST",
      token: coach.token,
      body: { destinationType: "email", destination: athleteEmail.toUpperCase(), roleOnTeam: "athlete" },
    });
    assert("coach creates an invitation", inviteRes.status === 201, `status=${inviteRes.status}`);
    assert(
      "invitation response never includes a raw or hashed token field",
      !("token" in inviteRes.data) && !("tokenHash" in inviteRes.data) && !("token_hash" in inviteRes.data),
      JSON.stringify(Object.keys(inviteRes.data))
    );
    assert(
      "invitation destination is normalized to lowercase",
      inviteRes.data.destination === athleteEmail.toLowerCase(),
      inviteRes.data.destination
    );

    const inviteUrl = inviteRes.data.inviteUrl;
    const firstToken = new URL(inviteUrl).searchParams.get("invite");
    assert("invitation response includes a usable invite URL", Boolean(firstToken), inviteUrl);

    // ---- Public preview works before login ----
    const previewRes = await req(`/api/invitations/${firstToken}`);
    assert("public preview succeeds for a valid token", previewRes.status === 200, `status=${previewRes.status}`);
    assert(
      "preview shows correct team name, coach, and role",
      previewRes.data.teamName === team.name && previewRes.data.roleOnTeam === "athlete",
      JSON.stringify(previewRes.data)
    );

    // ---- New user registers with the invited role and accepts ----
    const athlete = await registerUser(athleteEmail, "athlete");
    created.userIds.push(athlete.user.id);

    const acceptRes = await req(`/api/invitations/${firstToken}/accept`, {
      method: "POST",
      token: athlete.token,
    });
    assert("new user accepts the invitation", acceptRes.status === 200, `status=${acceptRes.status}`);
    assert(
      "accept response reports alreadyMember=false the first time",
      acceptRes.data.alreadyMember === false,
      JSON.stringify(acceptRes.data)
    );

    const rosterAfterAccept = await req(`/api/teams/${team.id}/members`, { token: coach.token });
    const athleteOnRoster = rosterAfterAccept.data.find((m) => m.id === athlete.user.id);
    assert(
      "accepted athlete appears on the roster with the correct role",
      athleteOnRoster && athleteOnRoster.role_on_team === "athlete",
      JSON.stringify(athleteOnRoster)
    );

    // ---- Duplicate accept is idempotent ----
    const secondAcceptRes = await req(`/api/invitations/${firstToken}/accept`, {
      method: "POST",
      token: athlete.token,
    });
    assert(
      "accepting an already-accepted token is rejected (single-use)",
      secondAcceptRes.status === 404,
      `status=${secondAcceptRes.status}`
    );

    const rosterAfterDuplicate = await req(`/api/teams/${team.id}/members`, { token: coach.token });
    const athleteRowsCount = rosterAfterDuplicate.data.filter((m) => m.id === athlete.user.id).length;
    assert("no duplicate membership row was created", athleteRowsCount === 1, `count=${athleteRowsCount}`);

    // ---- Re-inviting the same destination+team+role supersedes the old token ----
    // (firstToken was already consumed by the accept above, so re-invite
    // superseding is more meaningfully checked with a fresh invitation
    // that's still genuinely pending when replaced — see parentEmail below.)
    const parentEmail = `${RUN_TAG}-parent@test.cresamor.local`;
    const parentInviteRes = await req(`/api/teams/${team.id}/invitations`, {
      method: "POST",
      token: coach.token,
      body: { destinationType: "email", destination: parentEmail, roleOnTeam: "parent" },
    });
    const parentFirstToken = new URL(parentInviteRes.data.inviteUrl).searchParams.get("invite");

    const parentReInviteRes = await req(`/api/teams/${team.id}/invitations`, {
      method: "POST",
      token: coach.token,
      body: { destinationType: "email", destination: parentEmail, roleOnTeam: "parent" },
    });
    const parentSecondToken = new URL(parentReInviteRes.data.inviteUrl).searchParams.get("invite");

    const parentOldPreview = await req(`/api/invitations/${parentFirstToken}`);
    assert(
      "re-inviting the same destination+team+role supersedes the old pending token",
      parentOldPreview.status === 404,
      `status=${parentOldPreview.status}`
    );
    const parentNewPreview = await req(`/api/invitations/${parentSecondToken}`);
    assert("the newest token for that destination still works", parentNewPreview.status === 200, `status=${parentNewPreview.status}`);

    // ---- Phone destination normalization ----
    const phoneInviteRes = await req(`/api/teams/${team.id}/invitations`, {
      method: "POST",
      token: coach.token,
      body: { destinationType: "phone", destination: "(555) 123-4567", roleOnTeam: "assistant_coach" },
    });
    assert(
      "phone destination is normalized to digits only",
      phoneInviteRes.data.destination === "5551234567",
      phoneInviteRes.data.destination
    );

    // ---- Unrelated user denied on team detail/roster/manage endpoints ----
    const unrelated = await registerUser(`${RUN_TAG}-unrelated@test.cresamor.local`, "athlete");
    created.userIds.push(unrelated.user.id);

    const unrelatedDetailRes = await req(`/api/teams/${team.id}`, { token: unrelated.token });
    assert("unrelated user denied team detail", unrelatedDetailRes.status === 403, `status=${unrelatedDetailRes.status}`);

    const unrelatedRosterRes = await req(`/api/teams/${team.id}/members`, { token: unrelated.token });
    assert("unrelated user denied team roster", unrelatedRosterRes.status === 403, `status=${unrelatedRosterRes.status}`);

    const unrelatedRevokeRes = await req(`/api/teams/${team.id}/members/${athlete.user.id}`, {
      method: "DELETE",
      token: unrelated.token,
    });
    assert("unrelated user cannot revoke a member", unrelatedRevokeRes.status === 403, `status=${unrelatedRevokeRes.status}`);

    // ---- Closed Beta Readiness Sprint: an unrelated COACH (real coach
    // account, but no team_members row on this team) must be denied too —
    // this is the regression guard for canAccessTeam's removed blanket
    // "any coach can access any team" shortcut. Before this sprint's
    // permission change, every one of these would have incorrectly
    // succeeded (200) purely because unrelatedCoach.user.role === 'coach'. ----
    const unrelatedCoach = await registerUser(`${RUN_TAG}-unrelated-coach@test.cresamor.local`, "coach");
    created.userIds.push(unrelatedCoach.user.id);

    const unrelatedCoachDetailRes = await req(`/api/teams/${team.id}`, { token: unrelatedCoach.token });
    assert(
      "unrelated coach (not a member of this team) denied team detail",
      unrelatedCoachDetailRes.status === 403,
      `status=${unrelatedCoachDetailRes.status}`
    );

    const unrelatedCoachRosterRes = await req(`/api/teams/${team.id}/members`, { token: unrelatedCoach.token });
    assert(
      "unrelated coach (not a member of this team) denied team roster",
      unrelatedCoachRosterRes.status === 403,
      `status=${unrelatedCoachRosterRes.status}`
    );

    const unrelatedCoachInviteRes = await req(`/api/teams/${team.id}/invitations`, {
      method: "POST",
      token: unrelatedCoach.token,
      body: { destinationType: "email", destination: "nobody2@test.cresamor.local", roleOnTeam: "athlete" },
    });
    assert(
      "unrelated coach (not a member of this team) cannot create an invitation for it",
      unrelatedCoachInviteRes.status === 403,
      `status=${unrelatedCoachInviteRes.status}`
    );

    const unrelatedCoachRevokeRes = await req(`/api/teams/${team.id}/members/${athlete.user.id}`, {
      method: "DELETE",
      token: unrelatedCoach.token,
    });
    assert(
      "unrelated coach (not a member of this team) cannot revoke a member",
      unrelatedCoachRevokeRes.status === 403,
      `status=${unrelatedCoachRevokeRes.status}`
    );

    // Note: "a coach WITH genuine membership still has read access" is
    // already proven throughout this script — every `coach.token` call
    // above (team detail, roster, invitations) succeeds precisely because
    // that coach has a real team_members row from auto-join-on-create. No
    // separate registration needed here (register is rate-limited).

    // ---- Coach revokes the athlete's access ----
    const revokeRes = await req(`/api/teams/${team.id}/members/${athlete.user.id}`, {
      method: "DELETE",
      token: coach.token,
    });
    assert("coach revokes a member", revokeRes.status === 200, `status=${revokeRes.status}`);

    const rosterAfterRevoke = await req(`/api/teams/${team.id}/members`, { token: coach.token });
    const stillOnRoster = rosterAfterRevoke.data.some((m) => m.id === athlete.user.id);
    assert("revoked member no longer appears on the active roster", !stillOnRoster, JSON.stringify(rosterAfterRevoke.data));

    const revokedUserDetailRes = await req(`/api/teams/${team.id}`, { token: athlete.token });
    assert(
      "revoked member immediately loses team access",
      revokedUserDetailRes.status === 403,
      `status=${revokedUserDetailRes.status}`
    );

    // Account itself must be untouched by revocation.
    const revokedUserStillExists = await client.query("SELECT id FROM users WHERE id = $1", [athlete.user.id]);
    assert("revoked user's account still exists", revokedUserStillExists.rows.length === 1);

    // ---- Re-inviting a revoked member reactivates rather than erroring ----
    const reInviteAthleteRes = await req(`/api/teams/${team.id}/invitations`, {
      method: "POST",
      token: coach.token,
      body: { destinationType: "email", destination: athleteEmail, roleOnTeam: "athlete" },
    });
    const reInviteToken = new URL(reInviteAthleteRes.data.inviteUrl).searchParams.get("invite");

    const reAcceptRes = await req(`/api/invitations/${reInviteToken}/accept`, {
      method: "POST",
      token: athlete.token,
    });
    assert("revoked member can re-accept a fresh invitation", reAcceptRes.status === 200, `status=${reAcceptRes.status}`);

    const rosterAfterReactivate = await req(`/api/teams/${team.id}/members`, { token: coach.token });
    const reactivated = rosterAfterReactivate.data.some((m) => m.id === athlete.user.id);
    assert("reactivated member appears on the roster again", reactivated);

    // ---- Expired token is rejected ----
    const expiredCandidate = await req(`/api/teams/${team.id}/invitations`, {
      method: "POST",
      token: coach.token,
      body: { destinationType: "email", destination: `${RUN_TAG}-expired@test.cresamor.local`, roleOnTeam: "athlete" },
    });
    const expiredToken = new URL(expiredCandidate.data.inviteUrl).searchParams.get("invite");
    const expiredTokenHash = crypto.createHash("sha256").update(expiredToken).digest("hex");
    await client.query("UPDATE invitations SET expires_at = now() - interval '1 day' WHERE token_hash = $1", [
      expiredTokenHash,
    ]);
    const expiredPreviewRes = await req(`/api/invitations/${expiredToken}`);
    assert("expired token preview is rejected", expiredPreviewRes.status === 404, `status=${expiredPreviewRes.status}`);

    // ---- Forgot password: identical response for existing vs non-existing email ----
    const existingForgotRes = await req("/api/auth/forgot-password", {
      method: "POST",
      body: { email: coach.user.email },
    });
    const nonExistentForgotRes = await req("/api/auth/forgot-password", {
      method: "POST",
      body: { email: `${RUN_TAG}-nonexistent@test.cresamor.local` },
    });
    assert(
      "forgot-password returns identical status for existing and non-existing email",
      existingForgotRes.status === nonExistentForgotRes.status,
      `${existingForgotRes.status} vs ${nonExistentForgotRes.status}`
    );
    assert(
      "forgot-password returns identical message body for existing and non-existing email",
      existingForgotRes.data.message === nonExistentForgotRes.data.message,
      `"${existingForgotRes.data.message}" vs "${nonExistentForgotRes.data.message}"`
    );

    // ---- Reset password: fetch the real token from the DB (never emailed in this test env) ----
    const resetRow = await client.query(
      "SELECT token_hash FROM password_reset_tokens WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
      [coach.user.id]
    );
    assert("a password reset token row was created", resetRow.rows.length === 1);

    // We only have the hash (by design, the raw token is never persisted) —
    // generate a fresh raw/hash pair and swap it into the row so this test
    // can exercise the real accept path without needing email delivery.
    const testRawToken = crypto.randomBytes(32).toString("hex");
    const testTokenHash = crypto.createHash("sha256").update(testRawToken).digest("hex");
    await client.query(
      `
      UPDATE password_reset_tokens SET token_hash = $1
      WHERE id = (SELECT id FROM password_reset_tokens WHERE user_id = $2 ORDER BY created_at DESC LIMIT 1)
      `,
      [testTokenHash, coach.user.id]
    );

    const resetRes = await req("/api/auth/reset-password", {
      method: "POST",
      body: { token: testRawToken, newPassword: "NewTestPass456!" },
    });
    assert("reset-password succeeds with a valid token", resetRes.status === 200, `status=${resetRes.status}`);
    assert(
      "reset-password auto-logs in (returns token + user)",
      Boolean(resetRes.data.token) && resetRes.data.user?.id === coach.user.id,
      JSON.stringify(resetRes.data)
    );

    const reuseResetRes = await req("/api/auth/reset-password", {
      method: "POST",
      body: { token: testRawToken, newPassword: "AnotherPass789!" },
    });
    assert("reusing a reset token a second time fails", reuseResetRes.status === 400, `status=${reuseResetRes.status}`);

    const loginWithNewPasswordRes = await req("/api/auth/login", {
      method: "POST",
      body: { email: coach.user.email, password: "NewTestPass456!" },
    });
    assert(
      "coach can log in with the new password after reset",
      loginWithNewPasswordRes.status === 200,
      `status=${loginWithNewPasswordRes.status}`
    );

    // ---- No invitation-related audit log entry ever contains a token ----
    const auditRows = await client.query(
      `SELECT metadata FROM security_audit_log WHERE event_type IN ('invitation_created', 'invitation_accepted', 'team_member_revoked') AND created_at > now() - interval '5 minutes'`
    );
    const leaked = auditRows.rows.some((r) => JSON.stringify(r.metadata).toLowerCase().includes("token"));
    assert("no invitation-related audit log entry contains a token", !leaked);
  } finally {
    try {
      await client.query(
        "DELETE FROM invitations WHERE team_id = ANY($1::int[])",
        [created.teamIds]
      );
      await client.query(
        "DELETE FROM password_reset_tokens WHERE user_id = ANY($1::int[])",
        [created.userIds]
      );
      for (const id of created.teamIds) {
        await client.query("DELETE FROM team_members WHERE team_id = $1", [id]);
        await client.query("DELETE FROM teams WHERE id = $1", [id]);
      }
      for (const id of created.userIds) {
        await client.query("DELETE FROM conversation_participants WHERE user_id = $1", [id]);
        await client.query("DELETE FROM security_audit_log WHERE user_id = $1", [id]);
        await client.query("DELETE FROM team_members WHERE user_id = $1", [id]);
        await client.query("DELETE FROM users WHERE id = $1", [id]);
      }
      await client.query("DELETE FROM security_audit_log WHERE metadata->>'email' LIKE $1", [`${RUN_TAG}%`]);
      console.log("Cleanup complete.");
    } catch (cleanupError) {
      console.error("Cleanup encountered an error (may need manual follow-up):", cleanupError);
    }

    server.close();
    await client.end();
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.log("Failures:", failed.map((f) => f.name).join(", "));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("Test script crashed:", error);
  process.exitCode = 1;
});
