/*
  testMessagesTeamScoping.js — Messages team-scoping acceptance script.
  Same shape as testAuth.js/testInvitations.js/testPlatformAdmin.js: plain
  Node, real app on a throwaway local port, real fetch() calls,
  RUN_TAG-namespaced rows, full cleanup in a finally block regardless of
  pass/fail.

  Covers: cross-team message isolation, instant revocation of GET/POST
  access, a user who was never a team member, no Platform Admin bypass,
  a multi-team user seeing both conversations, and — the specific
  regression this redesign exists to prove — that team_members is now the
  real authorization source of truth, not conversation_participants: a
  stale/missing participant row must never block an active team member.

  Run by hand: ALLOW_PRODUCTION_TESTS=true node server/scripts/testMessagesTeamScoping.js
*/

require("dotenv").config();

const { requireProductionTestOptIn } = require("./lib/requireProductionTestOptIn");
requireProductionTestOptIn("testMessagesTeamScoping.js");

const jwt = require("jsonwebtoken");

const app = require("../app");
const client = require("../db/client");

const PORT = 3980;
const BASE_URL = `http://localhost:${PORT}`;
const RUN_TAG = `msgteam_${Date.now()}`;

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
    // ---- Setup: two coaches, each creating their own team (each coach
    // auto-gets a category='team' conversation + participant row) ----
    const coachA = await registerUser(`${RUN_TAG}-coachA@test.cresamor.local`, "coach");
    created.userIds.push(coachA.user.id);
    const teamARes = await req("/api/teams", {
      method: "POST",
      token: coachA.token,
      body: { name: `${RUN_TAG} Team A`, sport: "Wrestling" },
    });
    const teamA = teamARes.data;
    created.teamIds.push(teamA.id);
    assert("coach A creates Team A", teamARes.status === 201, `status=${teamARes.status}`);

    const coachB = await registerUser(`${RUN_TAG}-coachB@test.cresamor.local`, "coach");
    created.userIds.push(coachB.user.id);
    const teamBRes = await req("/api/teams", {
      method: "POST",
      token: coachB.token,
      body: { name: `${RUN_TAG} Team B`, sport: "Track" },
    });
    const teamB = teamBRes.data;
    created.teamIds.push(teamB.id);
    assert("coach B creates Team B", teamBRes.status === 201, `status=${teamBRes.status}`);

    // ---- Each team auto-got its own conversation at creation time ----
    const teamAConvos = await req("/api/conversations", { token: coachA.token });
    const teamAConvo = teamAConvos.data.find((c) => c.team_id === teamA.id);
    assert(
      "Team A's conversation exists and is visible to its own coach",
      Boolean(teamAConvo),
      JSON.stringify(teamAConvos.data)
    );

    const teamBConvos = await req("/api/conversations", { token: coachB.token });
    const teamBConvo = teamBConvos.data.find((c) => c.team_id === teamB.id);
    assert(
      "Team B's conversation exists and is visible to its own coach",
      Boolean(teamBConvo),
      JSON.stringify(teamBConvos.data)
    );

    // ---- Cross-team isolation: coach A cannot see or post to Team B's conversation ----
    const crossReadRes = await req(`/api/conversations/${teamBConvo.id}/messages`, { token: coachA.token });
    assert(
      "coach A (not on Team B) is blocked from reading Team B's conversation",
      crossReadRes.status === 403,
      `status=${crossReadRes.status}`
    );

    const crossPostRes = await req(`/api/conversations/${teamBConvo.id}/messages`, {
      method: "POST",
      token: coachA.token,
      body: { body: "should never land in Team B" },
    });
    assert(
      "coach A (not on Team B) is blocked from posting to Team B's conversation",
      crossPostRes.status === 403,
      `status=${crossPostRes.status}`
    );

    // A real message actually sent to Team A must never be visible via Team B's conversation.
    const teamAMessageRes = await req(`/api/conversations/${teamAConvo.id}/messages`, {
      method: "POST",
      token: coachA.token,
      body: { body: `${RUN_TAG} team A only message` },
    });
    assert("coach A posts a real message to Team A", teamAMessageRes.status === 201, `status=${teamAMessageRes.status}`);

    const teamBMessagesRes = await req(`/api/conversations/${teamBConvo.id}/messages`, { token: coachB.token });
    const leaked = teamBMessagesRes.data?.some((m) => m.body === `${RUN_TAG} team A only message`);
    assert("Team A's message never appears in Team B's conversation", leaked === false);

    // ---- Never-a-member: a third user with no relationship to Team A at all ----
    const outsider = await registerUser(`${RUN_TAG}-outsider@test.cresamor.local`, "athlete");
    created.userIds.push(outsider.user.id);

    const outsiderReadRes = await req(`/api/conversations/${teamAConvo.id}/messages`, { token: outsider.token });
    assert(
      "a user who was never a Team A member is blocked from reading it",
      outsiderReadRes.status === 403,
      `status=${outsiderReadRes.status}`
    );

    // ---- Platform Admin receives no special message access ----
    await client.query("UPDATE users SET is_platform_admin = true WHERE id = $1", [outsider.user.id]);
    const adminReadRes = await req(`/api/conversations/${teamAConvo.id}/messages`, { token: outsider.token });
    assert(
      "a platform admin who is NOT a Team A member is still blocked (no admin bypass)",
      adminReadRes.status === 403,
      `status=${adminReadRes.status}`
    );
    const adminListRes = await req("/api/conversations", { token: outsider.token });
    const adminSeesTeamA = adminListRes.data?.some((c) => c.id === teamAConvo.id);
    assert(
      "a platform admin's own conversation list does not include Team A's conversation",
      adminSeesTeamA === false,
      JSON.stringify(adminListRes.data)
    );

    // ---- Multi-team user: an athlete on both Team A and Team B ----
    const multiTeamAthlete = await registerUser(`${RUN_TAG}-multiathlete@test.cresamor.local`, "athlete");
    created.userIds.push(multiTeamAthlete.user.id);

    await req(`/api/users/${multiTeamAthlete.user.id}/teams`, {
      method: "POST",
      token: coachA.token,
      body: { team_id: teamA.id, role_on_team: "athlete" },
    });
    await req(`/api/users/${multiTeamAthlete.user.id}/teams`, {
      method: "POST",
      token: coachB.token,
      body: { team_id: teamB.id, role_on_team: "athlete" },
    });

    const multiTeamConvos = await req("/api/conversations", { token: multiTeamAthlete.token });
    const seesTeamA = multiTeamConvos.data?.some((c) => c.id === teamAConvo.id);
    const seesTeamB = multiTeamConvos.data?.some((c) => c.id === teamBConvo.id);
    assert(
      "a user on both teams sees BOTH conversations in their list",
      seesTeamA && seesTeamB,
      JSON.stringify(multiTeamConvos.data)
    );

    const multiTeamReadA = await req(`/api/conversations/${teamAConvo.id}/messages`, { token: multiTeamAthlete.token });
    const multiTeamReadB = await req(`/api/conversations/${teamBConvo.id}/messages`, { token: multiTeamAthlete.token });
    assert("multi-team user can read Team A's messages", multiTeamReadA.status === 200, `status=${multiTeamReadA.status}`);
    assert("multi-team user can read Team B's messages", multiTeamReadB.status === 200, `status=${multiTeamReadB.status}`);

    // ---- Instant revocation: removing a member from Team A immediately
    // blocks BOTH GET and POST for that conversation ----
    const revokeRes = await req(`/api/teams/${teamA.id}/members/${multiTeamAthlete.user.id}`, {
      method: "DELETE",
      token: coachA.token,
    });
    assert("coach A revokes the multi-team athlete from Team A", revokeRes.status === 200, `status=${revokeRes.status}`);

    const postRevokeReadRes = await req(`/api/conversations/${teamAConvo.id}/messages`, {
      token: multiTeamAthlete.token,
    });
    assert(
      "revoked member immediately loses GET access to Team A's conversation",
      postRevokeReadRes.status === 403,
      `status=${postRevokeReadRes.status}`
    );

    const postRevokePostRes = await req(`/api/conversations/${teamAConvo.id}/messages`, {
      method: "POST",
      token: multiTeamAthlete.token,
      body: { body: "should be rejected" },
    });
    assert(
      "revoked member immediately loses POST access to Team A's conversation",
      postRevokePostRes.status === 403,
      `status=${postRevokePostRes.status}`
    );

    // Revocation from Team A must not affect their still-active Team B access.
    const stillTeamBRes = await req(`/api/conversations/${teamBConvo.id}/messages`, { token: multiTeamAthlete.token });
    assert(
      "revocation from Team A does not affect the same user's still-active Team B access",
      stillTeamBRes.status === 200,
      `status=${stillTeamBRes.status}`
    );

    // ---- The core regression this redesign exists to prove: team_members
    // is the real authorization source of truth, not
    // conversation_participants. A stale/missing participant row must
    // never block an active team member. ----
    const freshAthlete = await registerUser(`${RUN_TAG}-freshathlete@test.cresamor.local`, "athlete");
    created.userIds.push(freshAthlete.user.id);

    const joinRes = await req(`/api/users/${freshAthlete.user.id}/teams`, {
      method: "POST",
      token: coachA.token,
      body: { team_id: teamA.id, role_on_team: "athlete" },
    });
    assert("fresh athlete joins Team A", joinRes.status === 201, `status=${joinRes.status}`);

    // Confirm the join-time code path actually seeded a participant row,
    // then deliberately delete it to simulate drift/a missed insert point
    // — access must survive this regardless.
    const participantRowBefore = await client.query(
      "SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2",
      [teamAConvo.id, freshAthlete.user.id]
    );
    assert(
      "join-time code seeded a conversation_participants row (read-state bookkeeping)",
      participantRowBefore.rows.length === 1
    );

    await client.query(
      "DELETE FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2",
      [teamAConvo.id, freshAthlete.user.id]
    );

    const participantRowAfterDelete = await client.query(
      "SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2",
      [teamAConvo.id, freshAthlete.user.id]
    );
    assert("participant row genuinely deleted (test setup sanity check)", participantRowAfterDelete.rows.length === 0);

    const readDespiteNoParticipantRow = await req(`/api/conversations/${teamAConvo.id}/messages`, {
      token: freshAthlete.token,
    });
    assert(
      "active team member can still READ their team's conversation with NO conversation_participants row at all",
      readDespiteNoParticipantRow.status === 200,
      `status=${readDespiteNoParticipantRow.status}`
    );

    const postDespiteNoParticipantRow = await req(`/api/conversations/${teamAConvo.id}/messages`, {
      method: "POST",
      token: freshAthlete.token,
      body: { body: `${RUN_TAG} sent with no participant row` },
    });
    assert(
      "active team member can still POST to their team's conversation with NO conversation_participants row at all",
      postDespiteNoParticipantRow.status === 201,
      `status=${postDespiteNoParticipantRow.status}`
    );

    const listDespiteNoParticipantRow = await req("/api/conversations", { token: freshAthlete.token });
    const stillListed = listDespiteNoParticipantRow.data?.some((c) => c.id === teamAConvo.id);
    assert(
      "active team member's conversation list still includes their team with NO participant row",
      stillListed === true,
      JSON.stringify(listDespiteNoParticipantRow.data)
    );

    // ---- Registration no longer auto-joins any shared conversation ----
    // Deliberately NOT going through POST /api/auth/register here — this
    // script's own registrations already use most of registerLimiter's
    // 5-per-hour-per-IP budget for this process, and this specific check
    // only needs a real user row + a validly-signed token, not the
    // register endpoint itself. Same direct-insert-and-hand-sign pattern
    // testAuth.js already uses for its expired-token check.
    const brandNewUserResult = await client.query(
      `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id, email`,
      [`${RUN_TAG}-brandnew@test.cresamor.local`, "not-a-real-hash-this-user-never-logs-in", "athlete"]
    );
    const brandNewUserId = brandNewUserResult.rows[0].id;
    created.userIds.push(brandNewUserId);
    const brandNewUserToken = jwt.sign({ id: brandNewUserId }, process.env.JWT_SECRET, { expiresIn: "1h" });

    const brandNewConvos = await req("/api/conversations", { token: brandNewUserToken });
    assert(
      "a brand-new user with no team belongs to zero conversations (no blanket auto-join)",
      Array.isArray(brandNewConvos.data) && brandNewConvos.data.length === 0,
      JSON.stringify(brandNewConvos.data)
    );
  } finally {
    try {
      for (const id of created.teamIds) {
        const convoRows = await client.query("SELECT id FROM conversations WHERE team_id = $1", [id]);
        for (const row of convoRows.rows) {
          await client.query("DELETE FROM messages WHERE conversation_id = $1", [row.id]);
          await client.query("DELETE FROM conversation_participants WHERE conversation_id = $1", [row.id]);
        }
        await client.query("DELETE FROM conversations WHERE team_id = $1", [id]);
        await client.query("DELETE FROM invitations WHERE team_id = $1", [id]);
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
