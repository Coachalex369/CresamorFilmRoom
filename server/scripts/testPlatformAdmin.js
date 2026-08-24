/*
  testPlatformAdmin.js — Platform Admin + Coach-level invitations
  acceptance script. Same shape as testAuth.js/testInvitations.js: plain
  Node, real app on a throwaway local port, real fetch() calls,
  RUN_TAG-namespaced rows, full cleanup in a finally block regardless of
  pass/fail.

  Covers: is_platform_admin defaults false and is never token-stale; a
  non-admin coach cannot send a Coach-level invitation; a platform admin
  can, and accepting it produces team_members.role_on_team='coach'; the
  existing assistant_coach/athlete/parent invitation paths are unchanged
  for a non-admin coach; the beta hand-off self-removal flow (admin steps
  down once a real Coach is active) succeeds; and self-removal is blocked
  when it would leave a team with zero active coaches.

  Run by hand: ALLOW_PRODUCTION_TESTS=true node server/scripts/testPlatformAdmin.js
*/

require("dotenv").config();

const { requireProductionTestOptIn } = require("./lib/requireProductionTestOptIn");
requireProductionTestOptIn("testPlatformAdmin.js");

const app = require("../app");
const client = require("../db/client");

const PORT = 3985;
const BASE_URL = `http://localhost:${PORT}`;
const RUN_TAG = `platformadmin_${Date.now()}`;

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

async function grantPlatformAdmin(userId) {
  await client.query("UPDATE users SET is_platform_admin = true WHERE id = $1", [userId]);
}

async function main() {
  const created = { userIds: [], teamIds: [] };
  const server = app.listen(PORT);

  try {
    // ---- is_platform_admin defaults false ----
    const plainCoach = await registerUser(`${RUN_TAG}-coach@test.cresamor.local`, "coach");
    created.userIds.push(plainCoach.user.id);
    assert(
      "freshly registered account defaults is_platform_admin=false",
      plainCoach.user.is_platform_admin === false,
      JSON.stringify(plainCoach.user)
    );

    // ---- Non-admin coach cannot send a Coach-level invitation ----
    const teamRes = await req("/api/teams", {
      method: "POST",
      token: plainCoach.token,
      body: { name: `${RUN_TAG} Team`, sport: "Wrestling" },
    });
    assert("coach creates a team", teamRes.status === 201, `status=${teamRes.status}`);
    const team = teamRes.data;
    created.teamIds.push(team.id);

    const beforeAdminInvite = await req(`/api/teams/${team.id}/invitations`, {
      method: "POST",
      token: plainCoach.token,
      body: { destinationType: "email", destination: `${RUN_TAG}-headcoach@test.cresamor.local`, roleOnTeam: "coach" },
    });
    assert(
      "non-admin coach (who DOES manage the team) cannot send a Coach-level invitation",
      beforeAdminInvite.status === 403,
      `status=${beforeAdminInvite.status}`
    );

    // ---- Existing invitation types unaffected for a non-admin coach ----
    const athleteInviteRes = await req(`/api/teams/${team.id}/invitations`, {
      method: "POST",
      token: plainCoach.token,
      body: { destinationType: "email", destination: `${RUN_TAG}-athlete@test.cresamor.local`, roleOnTeam: "athlete" },
    });
    assert(
      "non-admin coach can still send an Athlete invitation (regression)",
      athleteInviteRes.status === 201,
      `status=${athleteInviteRes.status}`
    );

    const assistantInviteRes = await req(`/api/teams/${team.id}/invitations`, {
      method: "POST",
      token: plainCoach.token,
      body: {
        destinationType: "email",
        destination: `${RUN_TAG}-assistant@test.cresamor.local`,
        roleOnTeam: "assistant_coach",
      },
    });
    assert(
      "non-admin coach can still send an Assistant Coach invitation (regression)",
      assistantInviteRes.status === 201,
      `status=${assistantInviteRes.status}`
    );

    // ---- Toggling is_platform_admin takes effect immediately on the SAME token ----
    await grantPlatformAdmin(plainCoach.user.id);

    const headCoachEmail = `${RUN_TAG}-headcoach@test.cresamor.local`;
    const afterAdminInvite = await req(`/api/teams/${team.id}/invitations`, {
      method: "POST",
      token: plainCoach.token, // same, already-issued token — no re-login
      body: { destinationType: "email", destination: headCoachEmail, roleOnTeam: "coach" },
    });
    assert(
      "same token, now platform admin, CAN send a Coach-level invitation (no token staleness)",
      afterAdminInvite.status === 201,
      `status=${afterAdminInvite.status}`
    );

    const coachInviteUrl = afterAdminInvite.data?.inviteUrl;
    const coachInviteToken = coachInviteUrl ? new URL(coachInviteUrl).searchParams.get("invite") : null;
    assert("Coach-level invitation includes a usable invite URL", Boolean(coachInviteToken), coachInviteUrl);

    const coachPreviewRes = await req(`/api/invitations/${coachInviteToken}`);
    assert(
      "public preview reports roleOnTeam='coach' and label 'Coach'",
      coachPreviewRes.data?.roleOnTeam === "coach" && coachPreviewRes.data?.roleLabel === "Coach",
      JSON.stringify(coachPreviewRes.data)
    );

    // ---- Accepting a Coach-level invitation produces role_on_team='coach' ----
    const headCoach = await registerUser(headCoachEmail, "coach");
    created.userIds.push(headCoach.user.id);

    const acceptRes = await req(`/api/invitations/${coachInviteToken}/accept`, {
      method: "POST",
      token: headCoach.token,
    });
    assert("invited user accepts the Coach-level invitation", acceptRes.status === 200, `status=${acceptRes.status}`);
    assert(
      "accept response reports roleOnTeam='coach'",
      acceptRes.data?.roleOnTeam === "coach",
      JSON.stringify(acceptRes.data)
    );

    const rosterAfterAccept = await req(`/api/teams/${team.id}/members`, { token: plainCoach.token });
    const headCoachOnRoster = rosterAfterAccept.data?.find((m) => m.id === headCoach.user.id);
    assert(
      "accepted user appears on roster with role_on_team='coach'",
      headCoachOnRoster && headCoachOnRoster.role_on_team === "coach",
      JSON.stringify(headCoachOnRoster)
    );

    const dbRoleCheck = await client.query(
      "SELECT role_on_team FROM team_members WHERE team_id = $1 AND user_id = $2 AND revoked_at IS NULL",
      [team.id, headCoach.user.id]
    );
    assert(
      "team_members row in the DB is genuinely role_on_team='coach', not just the API response",
      dbRoleCheck.rows[0]?.role_on_team === "coach",
      JSON.stringify(dbRoleCheck.rows[0])
    );

    // The new head coach should now independently pass canManageTeam.
    const headCoachInviteRes = await req(`/api/teams/${team.id}/invitations`, {
      method: "POST",
      token: headCoach.token,
      body: { destinationType: "email", destination: `${RUN_TAG}-athlete2@test.cresamor.local`, roleOnTeam: "athlete" },
    });
    assert(
      "the newly accepted Coach can manage the team (send an Athlete invitation)",
      headCoachInviteRes.status === 201,
      `status=${headCoachInviteRes.status}`
    );

    // The newly accepted Coach is NOT a platform admin themselves — must
    // not be able to mint further coaches.
    const headCoachTriesAdminInvite = await req(`/api/teams/${team.id}/invitations`, {
      method: "POST",
      token: headCoach.token,
      body: { destinationType: "email", destination: `${RUN_TAG}-anothercoach@test.cresamor.local`, roleOnTeam: "coach" },
    });
    assert(
      "the newly accepted Coach (not a platform admin) cannot themselves send a Coach-level invitation",
      headCoachTriesAdminInvite.status === 403,
      `status=${headCoachTriesAdminInvite.status}`
    );

    // ---- Self-removal is blocked when it would leave the team coachless ----
    // At this point in the test, team_members has exactly TWO active
    // coaches: plainCoach (admin, team creator) and headCoach (just
    // accepted). Prove the block using a SEPARATE, solo-coach team first,
    // so this assertion doesn't depend on ordering relative to the
    // hand-off removal below.
    const soloTeamRes = await req("/api/teams", {
      method: "POST",
      token: plainCoach.token,
      body: { name: `${RUN_TAG} Solo Team`, sport: "Track" },
    });
    const soloTeam = soloTeamRes.data;
    created.teamIds.push(soloTeam.id);

    const soloSelfRemoveRes = await req(`/api/teams/${soloTeam.id}/members/${plainCoach.user.id}`, {
      method: "DELETE",
      token: plainCoach.token,
    });
    assert(
      "self-removal is BLOCKED when it would leave the team with zero active coaches",
      soloSelfRemoveRes.status === 400,
      `status=${soloSelfRemoveRes.status} body=${JSON.stringify(soloSelfRemoveRes.data)}`
    );

    const soloRosterAfterBlockedRemove = await req(`/api/teams/${soloTeam.id}/members`, { token: plainCoach.token });
    const stillOnSoloRoster = soloRosterAfterBlockedRemove.data?.some((m) => m.id === plainCoach.user.id);
    assert("blocked self-removal did not actually revoke the membership", stillOnSoloRoster === true);

    // ---- Beta hand-off: self-removal SUCCEEDS once another active coach exists ----
    const handoffSelfRemoveRes = await req(`/api/teams/${team.id}/members/${plainCoach.user.id}`, {
      method: "DELETE",
      token: plainCoach.token,
    });
    assert(
      "admin self-removal SUCCEEDS once another active Coach (the invited head coach) exists",
      handoffSelfRemoveRes.status === 200,
      `status=${handoffSelfRemoveRes.status} body=${JSON.stringify(handoffSelfRemoveRes.data)}`
    );

    const rosterAfterHandoff = await req(`/api/teams/${team.id}/members`, { token: headCoach.token });
    const adminStillOnRoster = rosterAfterHandoff.data?.some((m) => m.id === plainCoach.user.id);
    const headCoachStillOnRoster = rosterAfterHandoff.data?.some((m) => m.id === headCoach.user.id);
    assert("admin no longer appears on the team roster after hand-off", adminStillOnRoster === false);
    assert("the real head coach remains on the roster after hand-off", headCoachStillOnRoster === true);

    // ---- Platform admin status is independent of team membership ----
    const adminAfterHandoffOwnTeamsRes = await req(`/api/users/${plainCoach.user.id}/teams`, {
      token: plainCoach.token,
    });
    const stillOnMyTeamsList = adminAfterHandoffOwnTeamsRes.data?.some((t) => t.id === team.id);
    assert(
      "admin no longer lists the handed-off team under their own teams",
      stillOnMyTeamsList === false,
      JSON.stringify(adminAfterHandoffOwnTeamsRes.data)
    );

    const adminCanStillInviteElsewhereRes = await req(`/api/teams/${soloTeam.id}/invitations`, {
      method: "POST",
      token: plainCoach.token,
      body: { destinationType: "email", destination: `${RUN_TAG}-solo-athlete@test.cresamor.local`, roleOnTeam: "coach" },
    });
    assert(
      "admin's platform-admin status (Coach-invite ability) persists on an unrelated team they still belong to, despite no longer belonging to the handed-off team",
      adminCanStillInviteElsewhereRes.status === 201,
      `status=${adminCanStillInviteElsewhereRes.status}`
    );

    // ---- Regression: unrelated user is still blocked (sanity spot-check on unchanged permission functions) ----
    const outsider = await registerUser(`${RUN_TAG}-outsider@test.cresamor.local`, "athlete");
    created.userIds.push(outsider.user.id);

    const outsiderDetailRes = await req(`/api/teams/${team.id}`, { token: outsider.token });
    assert(
      "unrelated user still blocked from team detail (canAccessTeam unchanged)",
      outsiderDetailRes.status === 403,
      `status=${outsiderDetailRes.status}`
    );

    const outsiderRevokeRes = await req(`/api/teams/${team.id}/members/${headCoach.user.id}`, {
      method: "DELETE",
      token: outsider.token,
    });
    assert(
      "unrelated user still cannot revoke a member (canManageTeam unchanged)",
      outsiderRevokeRes.status === 403,
      `status=${outsiderRevokeRes.status}`
    );
  } finally {
    try {
      await client.query("DELETE FROM invitations WHERE team_id = ANY($1::int[])", [created.teamIds]);
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
