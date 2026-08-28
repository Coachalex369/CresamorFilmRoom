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
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

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

// Same convention as this project's newer test scripts (testDirectMessaging.js,
// testRosterProfiles.js): direct-insert plus a hand-signed JWT for any test
// user that's just SETUP, not the thing actually under test -- registerUser()
// above hits the real, rate-limited /api/auth/register endpoint
// (registerLimiter: 5/hour/IP), which this file was already at the edge of
// budget-wise before the existing-user multi-team invitation correction
// added more test users on top. Real registration is still used wherever a
// test's whole point IS registration/login behavior (see the "multi-team
// parent registers for the first time" and "registering an already-
// registered email returns 409" checks below) -- this helper is only for
// users that merely need to exist.
async function createTestUser(email, role) {
  const hash = await bcrypt.hash("TestPass123!", 10);
  const result = await client.query(
    `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id, email, role`,
    [email, hash, role]
  );
  const user = result.rows[0];
  const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: "1h" });
  return { token, user };
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
    const outsider = await createTestUser(`${RUN_TAG}-outsider@test.cresamor.local`, "athlete");
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
    const unrelated = await createTestUser(`${RUN_TAG}-unrelated@test.cresamor.local`, "athlete");
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
    const unrelatedCoach = await createTestUser(`${RUN_TAG}-unrelated-coach@test.cresamor.local`, "coach");
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

    // ==================================================================
    // Existing-user multi-team invitation correction
    // ==================================================================

    // ---- The exact required regression case: an existing Parent
    // already on Team A is invited with the same email to Team B, and
    // successfully joins Team B (identity/other-team roles untouched). ----
    const coachC = await createTestUser(`${RUN_TAG}-coachC@test.cresamor.local`, "coach");
    created.userIds.push(coachC.user.id);
    const teamARes2 = await req("/api/teams", {
      method: "POST",
      token: coachC.token,
      body: { name: `${RUN_TAG} Multi-team A`, sport: "Wrestling" },
    });
    const teamA2 = teamARes2.data;
    created.teamIds.push(teamA2.id);

    const coachD = await createTestUser(`${RUN_TAG}-coachD@test.cresamor.local`, "coach");
    created.userIds.push(coachD.user.id);
    const teamBRes2 = await req("/api/teams", {
      method: "POST",
      token: coachD.token,
      body: { name: `${RUN_TAG} Multi-team B`, sport: "Track" },
    });
    const teamB2 = teamBRes2.data;
    created.teamIds.push(teamB2.id);

    const parentEmail2 = `${RUN_TAG}-multiteam-parent@test.cresamor.local`;
    const parentPassword = "TestPass123!";

    // Parent joins Team A first, as a real registered account (not via
    // the test helper's raw /api/auth/register call this time -- go
    // through the actual invitation token so this mirrors production).
    const teamAInviteRes = await req(`/api/teams/${teamA2.id}/invitations`, {
      method: "POST",
      token: coachC.token,
      body: { destinationType: "email", destination: parentEmail2, roleOnTeam: "parent" },
    });
    const teamAToken = new URL(teamAInviteRes.data.inviteUrl).searchParams.get("invite");

    const teamARegisterRes = await req("/api/auth/register", {
      method: "POST",
      body: { email: parentEmail2, password: parentPassword, role: "parent" },
    });
    assert("multi-team parent registers for the first time", teamARegisterRes.status === 201, `status=${teamARegisterRes.status}`);
    const parentUserId = teamARegisterRes.data.user.id;
    created.userIds.push(parentUserId);
    const parentAuthToken1 = teamARegisterRes.data.token;

    const teamAAcceptRes = await req(`/api/invitations/${teamAToken}/accept`, {
      method: "POST",
      token: parentAuthToken1,
    });
    assert("parent accepts Team A invitation", teamAAcceptRes.status === 200, `status=${teamAAcceptRes.status}`);

    // Now invite that SAME email to a SECOND, unrelated team.
    const teamBInviteRes = await req(`/api/teams/${teamB2.id}/invitations`, {
      method: "POST",
      token: coachD.token,
      body: { destinationType: "email", destination: parentEmail2, roleOnTeam: "parent" },
    });
    assert("coach D can invite an email that already belongs to a user -- creates a pending invitation, not a registration attempt", teamBInviteRes.status === 201, `status=${teamBInviteRes.status}`);
    const teamBToken = new URL(teamBInviteRes.data.inviteUrl).searchParams.get("invite");

    // ---- Preview must show accountExists: true for this email ----
    const teamBPreviewRes = await req(`/api/invitations/${teamBToken}`);
    assert(
      "preview reports accountExists: true for an email that already has an account",
      teamBPreviewRes.data.accountExists === true,
      JSON.stringify(teamBPreviewRes.data)
    );

    // ---- The fix in action: the existing user logs in (does NOT
    // register again) and accepts -- this is what the corrected client
    // flow does when accountExists is true. ----
    const teamBLoginRes = await req("/api/auth/login", {
      method: "POST",
      body: { email: parentEmail2, password: parentPassword },
    });
    assert("existing parent logs in with their existing password (not a second registration)", teamBLoginRes.status === 200, `status=${teamBLoginRes.status}`);
    const parentAuthToken2 = teamBLoginRes.data.token;
    assert(
      "login returns the SAME account id -- not a newly created duplicate",
      teamBLoginRes.data.user.id === parentUserId,
      `${teamBLoginRes.data.user.id} vs ${parentUserId}`
    );

    const teamBAcceptRes = await req(`/api/invitations/${teamBToken}/accept`, {
      method: "POST",
      token: parentAuthToken2,
    });
    assert("existing parent accepts the Team B invitation and joins", teamBAcceptRes.status === 200, `status=${teamBAcceptRes.status}`);
    assert(
      "Team B accept reports alreadyMember=false (this is a genuinely new membership row)",
      teamBAcceptRes.data.alreadyMember === false,
      JSON.stringify(teamBAcceptRes.data)
    );

    const teamBRosterRes = await req(`/api/teams/${teamB2.id}/members`, { token: coachD.token });
    assert(
      "parent appears on Team B's roster",
      teamBRosterRes.data.some((m) => m.id === parentUserId),
      JSON.stringify(teamBRosterRes.data)
    );

    // ---- Identity/other-team roles must be untouched ----
    const teamARosterAfterRes = await req(`/api/teams/${teamA2.id}/members`, { token: coachC.token });
    const parentOnTeamA = teamARosterAfterRes.data.find((m) => m.id === parentUserId);
    assert(
      "parent's Team A membership is completely untouched by joining Team B",
      parentOnTeamA && parentOnTeamA.role_on_team === "parent",
      JSON.stringify(parentOnTeamA)
    );

    const bothMembershipRows = await client.query(
      "SELECT team_id, role_on_team FROM team_members WHERE user_id = $1 ORDER BY team_id",
      [parentUserId]
    );
    assert(
      "one account now has two SEPARATE team_members rows (multi-team, not an overwrite)",
      bothMembershipRows.rows.length === 2 &&
        bothMembershipRows.rows.some((r) => r.team_id === teamA2.id) &&
        bothMembershipRows.rows.some((r) => r.team_id === teamB2.id),
      JSON.stringify(bothMembershipRows.rows)
    );

    // ---- Repeated acceptance is idempotent (same token, second time) ----
    const teamBAcceptAgainRes = await req(`/api/invitations/${teamBToken}/accept`, {
      method: "POST",
      token: parentAuthToken2,
    });
    assert(
      "re-accepting the same Team B invitation is rejected (single-use token), not a duplicate row",
      teamBAcceptAgainRes.status === 404,
      `status=${teamBAcceptAgainRes.status}`
    );
    const teamBRosterCount = (
      await client.query("SELECT id FROM team_members WHERE team_id = $1 AND user_id = $2", [teamB2.id, parentUserId])
    ).rows.length;
    assert("still exactly one Team B membership row for this parent", teamBRosterCount === 1, `count=${teamBRosterCount}`);

    // ---- Reinviting can reactivate a revoked membership (Team B, not just Team A) ----
    await req(`/api/teams/${teamB2.id}/members/${parentUserId}`, { method: "DELETE", token: coachD.token });
    const teamBReInviteRes = await req(`/api/teams/${teamB2.id}/invitations`, {
      method: "POST",
      token: coachD.token,
      body: { destinationType: "email", destination: parentEmail2, roleOnTeam: "parent" },
    });
    const teamBReInviteToken = new URL(teamBReInviteRes.data.inviteUrl).searchParams.get("invite");
    const teamBReAcceptRes = await req(`/api/invitations/${teamBReInviteToken}/accept`, {
      method: "POST",
      token: parentAuthToken2,
    });
    assert("reinviting reactivates a revoked Team B membership", teamBReAcceptRes.status === 200, `status=${teamBReAcceptRes.status}`);
    const teamBRosterAfterReactivate = await req(`/api/teams/${teamB2.id}/members`, { token: coachD.token });
    assert(
      "parent is active on Team B's roster again after reactivation",
      teamBRosterAfterReactivate.data.some((m) => m.id === parentUserId),
      JSON.stringify(teamBRosterAfterReactivate.data)
    );

    // ---- accountExists: false for a genuinely new email ----
    const newEmailInviteRes = await req(`/api/teams/${teamA2.id}/invitations`, {
      method: "POST",
      token: coachC.token,
      body: { destinationType: "email", destination: `${RUN_TAG}-brandnew@test.cresamor.local`, roleOnTeam: "athlete" },
    });
    const newEmailToken = new URL(newEmailInviteRes.data.inviteUrl).searchParams.get("invite");
    const newEmailPreviewRes = await req(`/api/invitations/${newEmailToken}`);
    assert(
      "preview reports accountExists: false for an email with no existing account",
      newEmailPreviewRes.data.accountExists === false,
      JSON.stringify(newEmailPreviewRes.data)
    );

    // ---- accountExists: null for a phone invitation (no comparable identity to check) ----
    const phonePreviewInviteRes = await req(`/api/teams/${teamA2.id}/invitations`, {
      method: "POST",
      token: coachC.token,
      body: { destinationType: "phone", destination: "555-987-6543", roleOnTeam: "athlete" },
    });
    const phonePreviewToken = new URL(phonePreviewInviteRes.data.inviteUrl).searchParams.get("invite");
    const phonePreviewRes = await req(`/api/invitations/${phonePreviewToken}`);
    assert(
      "preview reports accountExists: null for a phone invitation",
      phonePreviewRes.data.accountExists === null,
      JSON.stringify(phonePreviewRes.data)
    );

    // ---- Registration hardening: registering an email that already has
    // an account now returns a clear 409, not an opaque 500 -- this is
    // the backstop if the client-side accountExists branch is ever wrong
    // about a given email. ----
    const duplicateRegisterRes = await req("/api/auth/register", {
      method: "POST",
      body: { email: parentEmail2, password: "SomeOtherPassword1!", role: "parent" },
    });
    assert(
      "registering an already-registered email returns 409 with a clear message, not a 500",
      duplicateRegisterRes.status === 409 && /already exists/i.test(duplicateRegisterRes.data.error || ""),
      `status=${duplicateRegisterRes.status} body=${JSON.stringify(duplicateRegisterRes.data)}`
    );

    // ---- In-app pending-invitation visibility: GET /api/invitations/mine ----
    const newUserForMine = await createTestUser(`${RUN_TAG}-mine-user@test.cresamor.local`, "athlete");
    created.userIds.push(newUserForMine.user.id);
    const mineInviteRes = await req(`/api/teams/${teamA2.id}/invitations`, {
      method: "POST",
      token: coachC.token,
      body: { destinationType: "email", destination: `${RUN_TAG}-mine-user@test.cresamor.local`, roleOnTeam: "athlete" },
    });
    assert("setup: invitation created for the /mine test user", mineInviteRes.status === 201, `status=${mineInviteRes.status}`);

    const mineListRes = await req("/api/invitations/mine", { token: newUserForMine.token });
    assert("GET /api/invitations/mine succeeds", mineListRes.status === 200, `status=${mineListRes.status}`);
    const mineEntry = mineListRes.data.find((inv) => inv.teamId === teamA2.id);
    assert(
      "the pending invitation appears in the invitee's own in-app list, with team and role shown",
      Boolean(mineEntry) && mineEntry.roleOnTeam === "athlete" && mineEntry.teamName === teamA2.name,
      JSON.stringify(mineListRes.data)
    );

    const mineListForUnrelated = await req("/api/invitations/mine", { token: coachD.token });
    assert(
      "GET /api/invitations/mine never shows another user's invitations",
      !mineListForUnrelated.data.some((inv) => inv.teamId === teamA2.id && inv.id === mineEntry.id),
      JSON.stringify(mineListForUnrelated.data)
    );

    // ---- Route-level proof: POST /api/invitations/by-id/:id/accept
    // reaches acceptInvitationById(), not the token-based handler -- the
    // two routes are structurally similar enough (one param segment then
    // /accept) that a registration-order mistake would silently route
    // one into the other. ----
    const wrongRouteAttempt = await req(`/api/invitations/${mineEntry.id}/accept`, {
      method: "POST",
      token: newUserForMine.token,
    });
    assert(
      "the numeric invitation id is NOT accidentally accepted as a token by the token-based route",
      wrongRouteAttempt.status === 404,
      `status=${wrongRouteAttempt.status} body=${JSON.stringify(wrongRouteAttempt.data)}`
    );

    const byIdAcceptRes = await req(`/api/invitations/by-id/${mineEntry.id}/accept`, {
      method: "POST",
      token: newUserForMine.token,
    });
    assert(
      "POST /api/invitations/by-id/:id/accept succeeds and reaches the real acceptance logic",
      byIdAcceptRes.status === 200 && byIdAcceptRes.data.team.id === teamA2.id,
      `status=${byIdAcceptRes.status} body=${JSON.stringify(byIdAcceptRes.data)}`
    );

    const mineRosterRes = await req(`/api/teams/${teamA2.id}/members`, { token: coachC.token });
    assert(
      "the by-id-accepted user actually appears on the roster (proves it reached applyInvitation, not a no-op)",
      mineRosterRes.data.some((m) => m.id === newUserForMine.user.id),
      JSON.stringify(mineRosterRes.data)
    );

    const mineListAfterAccept = await req("/api/invitations/mine", { token: newUserForMine.token });
    assert(
      "the invitation disappears from /mine once accepted (no longer pending)",
      !mineListAfterAccept.data.some((inv) => inv.id === mineEntry.id),
      JSON.stringify(mineListAfterAccept.data)
    );

    // ---- by-id accept is idempotent too, same as the token-based route ----
    const byIdAcceptAgainRes = await req(`/api/invitations/by-id/${mineEntry.id}/accept`, {
      method: "POST",
      token: newUserForMine.token,
    });
    assert(
      "re-accepting the same invitation by id is rejected (single-use), not a duplicate row",
      byIdAcceptAgainRes.status === 404,
      `status=${byIdAcceptAgainRes.status}`
    );

    // ---- account_mismatch still enforced on the by-id path too (not
    // just the token path) -- a different logged-in user cannot accept
    // someone else's invitation merely by knowing/guessing its id. ----
    const mismatchInviteRes = await req(`/api/teams/${teamA2.id}/invitations`, {
      method: "POST",
      token: coachC.token,
      body: { destinationType: "email", destination: `${RUN_TAG}-mismatch-target@test.cresamor.local`, roleOnTeam: "athlete" },
    });
    // We don't have an account for the invited destination, so use the
    // coach's own token (a real, different, logged-in account) to prove
    // the mismatch is rejected even via the id-based route -- we need
    // the invitation's numeric id, which /mine won't show coachC (wrong
    // email), so fetch it directly for test purposes.
    const mismatchTokenHash = crypto
      .createHash("sha256")
      .update(new URL(mismatchInviteRes.data.inviteUrl).searchParams.get("invite"))
      .digest("hex");
    const mismatchRow = await client.query("SELECT id FROM invitations WHERE token_hash = $1", [mismatchTokenHash]);
    const mismatchAttemptRes = await req(`/api/invitations/by-id/${mismatchRow.rows[0].id}/accept`, {
      method: "POST",
      token: coachC.token,
    });
    assert(
      "account_mismatch is enforced on the by-id accept route too, not just the token route",
      mismatchAttemptRes.status === 409 && mismatchAttemptRes.data.error === "account_mismatch",
      `status=${mismatchAttemptRes.status} body=${JSON.stringify(mismatchAttemptRes.data)}`
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
        // Messages team-scoping: POST /api/teams now auto-creates a
        // conversation for the team, which FK-references it — must be
        // torn down before the team row itself can be deleted.
        const convoRows = await client.query("SELECT id FROM conversations WHERE team_id = $1", [id]);
        for (const row of convoRows.rows) {
          await client.query("DELETE FROM messages WHERE conversation_id = $1", [row.id]);
          await client.query("DELETE FROM conversation_participants WHERE conversation_id = $1", [row.id]);
        }
        await client.query("DELETE FROM conversations WHERE team_id = $1", [id]);
        await client.query("DELETE FROM team_members WHERE team_id = $1", [id]);
        await client.query("DELETE FROM teams WHERE id = $1", [id]);
      }
      for (const id of created.userIds) {
        await client.query("DELETE FROM messages WHERE sender_id = $1", [id]);
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
