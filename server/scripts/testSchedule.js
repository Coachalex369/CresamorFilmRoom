/*
  testSchedule.js — Schedule feature acceptance script. Same shape as
  testAuth.js/testInvitations.js/testPlatformAdmin.js/
  testMessagesTeamScoping.js: plain Node, real app on a throwaway local
  port, real fetch() calls, RUN_TAG-namespaced rows, full cleanup in a
  finally block regardless of pass/fail.

  Uses direct-insert-plus-hand-signed-JWT for every test user (the same
  technique testMessagesTeamScoping.js used for exactly one user) rather
  than POST /api/auth/register -- this suite needs a large cast (coach,
  assistant coach, athlete, parent, outsider, platform admin, multi-team
  user, x2 teams) that would badly exceed registerLimiter's 5-per-hour-
  per-process budget if it went through the real register endpoint.
  Schedule's own authorization is what's under test here, not
  registration, so this is a legitimate substitution -- the token is
  identical to what a real login would produce.

  Run by hand: ALLOW_PRODUCTION_TESTS=true node server/scripts/testSchedule.js
*/

require("dotenv").config();

const { requireProductionTestOptIn } = require("./lib/requireProductionTestOptIn");
requireProductionTestOptIn("testSchedule.js");

const jwt = require("jsonwebtoken");

const app = require("../app");
const client = require("../db/client");

const PORT = 3975;
const BASE_URL = `http://localhost:${PORT}`;
const RUN_TAG = `schedule_${Date.now()}`;

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

async function createTestUser(email, globalRole, isPlatformAdmin = false) {
  const result = await client.query(
    `INSERT INTO users (email, password_hash, role, is_platform_admin) VALUES ($1, $2, $3, $4) RETURNING id, email`,
    [email, "not-a-real-hash-this-user-never-logs-in", globalRole, isPlatformAdmin]
  );
  const id = result.rows[0].id;
  const token = jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: "1h" });
  return { id, email, token };
}

function hoursFromNow(h) {
  return new Date(Date.now() + h * 60 * 60 * 1000).toISOString();
}

async function main() {
  const created = { userIds: [], teamIds: [], eventIds: [] };
  const server = app.listen(PORT);

  try {
    // ---- Setup: two real teams via the real POST /api/teams endpoint
    // (creates team + auto-conversation + auto team_members coach row --
    // unrelated to Schedule, just existing behavior we ride along with) ----
    const coachA = await createTestUser(`${RUN_TAG}-coachA@test.cresamor.local`, "coach");
    created.userIds.push(coachA.id);
    const teamARes = await req("/api/teams", {
      method: "POST",
      token: coachA.token,
      body: { name: `${RUN_TAG} Team A`, sport: "Wrestling" },
    });
    const teamA = teamARes.data;
    created.teamIds.push(teamA.id);
    assert("setup: coach A creates Team A", teamARes.status === 201, `status=${teamARes.status}`);

    const coachB = await createTestUser(`${RUN_TAG}-coachB@test.cresamor.local`, "coach");
    created.userIds.push(coachB.id);
    const teamBRes = await req("/api/teams", {
      method: "POST",
      token: coachB.token,
      body: { name: `${RUN_TAG} Team B`, sport: "Track" },
    });
    const teamB = teamBRes.data;
    created.teamIds.push(teamB.id);
    assert("setup: coach B creates Team B", teamBRes.status === 201, `status=${teamBRes.status}`);

    const teamCRes = await req("/api/teams", {
      method: "POST",
      token: coachB.token,
      body: { name: `${RUN_TAG} Team C (unrelated)`, sport: "Soccer" },
    });
    const teamC = teamCRes.data;
    created.teamIds.push(teamC.id);

    // ---- Team A roster: assistant coach, athlete, parent ----
    const assistantCoachA = await createTestUser(`${RUN_TAG}-assistantcoachA@test.cresamor.local`, "athlete");
    created.userIds.push(assistantCoachA.id);
    await req(`/api/users/${assistantCoachA.id}/teams`, {
      method: "POST",
      token: coachA.token,
      body: { team_id: teamA.id, role_on_team: "assistant_coach" },
    });

    const athleteA = await createTestUser(`${RUN_TAG}-athleteA@test.cresamor.local`, "athlete");
    created.userIds.push(athleteA.id);
    await req(`/api/users/${athleteA.id}/teams`, {
      method: "POST",
      token: coachA.token,
      body: { team_id: teamA.id, role_on_team: "athlete" },
    });

    const parentA = await createTestUser(`${RUN_TAG}-parentA@test.cresamor.local`, "parent");
    created.userIds.push(parentA.id);
    await req(`/api/users/${parentA.id}/teams`, {
      method: "POST",
      token: coachA.token,
      body: { team_id: teamA.id, role_on_team: "parent" },
    });

    // ---- Outsiders ----
    const outsider = await createTestUser(`${RUN_TAG}-outsider@test.cresamor.local`, "athlete");
    created.userIds.push(outsider.id);

    const platformAdminOutsider = await createTestUser(
      `${RUN_TAG}-platformadmin@test.cresamor.local`,
      "coach",
      true
    );
    created.userIds.push(platformAdminOutsider.id);

    // ---- Multi-team user: Team A + Team B, NOT Team C ----
    const multiTeamUser = await createTestUser(`${RUN_TAG}-multiteam@test.cresamor.local`, "athlete");
    created.userIds.push(multiTeamUser.id);
    await req(`/api/users/${multiTeamUser.id}/teams`, {
      method: "POST",
      token: coachA.token,
      body: { team_id: teamA.id, role_on_team: "athlete" },
    });
    await req(`/api/users/${multiTeamUser.id}/teams`, {
      method: "POST",
      token: coachB.token,
      body: { team_id: teamB.id, role_on_team: "athlete" },
    });

    // ==================================================================
    // 1-8: Create + view permission matrix
    // ==================================================================

    const createRes = await req(`/api/teams/${teamA.id}/events`, {
      method: "POST",
      token: coachA.token,
      body: {
        event_type: "practice",
        title: `${RUN_TAG} Practice`,
        location: "Main Gym",
        starts_at: hoursFromNow(48),
      },
    });
    assert("1. coach can create an event for Team A", createRes.status === 201, `status=${createRes.status}`);
    const eventA = createRes.data;
    if (createRes.status === 201) created.eventIds.push(eventA.id);

    const coachGetRes = await req(`/api/events/${eventA.id}`, { token: coachA.token });
    assert("2. Team A coach can retrieve it", coachGetRes.status === 200, `status=${coachGetRes.status}`);

    const assistantGetRes = await req(`/api/events/${eventA.id}`, { token: assistantCoachA.token });
    assert("3. Team A assistant coach can view it", assistantGetRes.status === 200, `status=${assistantGetRes.status}`);

    const athleteGetRes = await req(`/api/events/${eventA.id}`, { token: athleteA.token });
    assert("4. Team A athlete can view it", athleteGetRes.status === 200, `status=${athleteGetRes.status}`);

    const parentGetRes = await req(`/api/events/${eventA.id}`, { token: parentA.token });
    assert("5. Team A parent can view it", parentGetRes.status === 200, `status=${parentGetRes.status}`);

    const outsiderGetRes = await req(`/api/events/${eventA.id}`, { token: outsider.token });
    assert("6. non-member cannot retrieve Team A event", outsiderGetRes.status === 403, `status=${outsiderGetRes.status}`);
    const outsiderListRes = await req(`/api/teams/${teamA.id}/events`, { token: outsider.token });
    assert(
      "6b. non-member cannot list Team A schedule",
      outsiderListRes.status === 403,
      `status=${outsiderListRes.status}`
    );

    const coachBGetRes = await req(`/api/events/${eventA.id}`, { token: coachB.token });
    assert(
      "7. Team B member cannot retrieve Team A event merely by using Cresamor",
      coachBGetRes.status === 403,
      `status=${coachBGetRes.status}`
    );

    const adminGetRes = await req(`/api/events/${eventA.id}`, { token: platformAdminOutsider.token });
    assert(
      "8. Platform Admin with no Team A membership receives no Schedule bypass",
      adminGetRes.status === 403,
      `status=${adminGetRes.status}`
    );

    // ==================================================================
    // 9-14: Management permission matrix (create / edit / cancel / delete)
    // ==================================================================

    const assistantCreateRes = await req(`/api/teams/${teamA.id}/events`, {
      method: "POST",
      token: assistantCoachA.token,
      body: { event_type: "practice", title: "should not be allowed", starts_at: hoursFromNow(50) },
    });
    assert("9. assistant coach cannot create an event", assistantCreateRes.status === 403, `status=${assistantCreateRes.status}`);

    const athleteCreateRes = await req(`/api/teams/${teamA.id}/events`, {
      method: "POST",
      token: athleteA.token,
      body: { event_type: "practice", title: "should not be allowed", starts_at: hoursFromNow(50) },
    });
    assert("10. athlete cannot create an event", athleteCreateRes.status === 403, `status=${athleteCreateRes.status}`);

    const parentCreateRes = await req(`/api/teams/${teamA.id}/events`, {
      method: "POST",
      token: parentA.token,
      body: { event_type: "practice", title: "should not be allowed", starts_at: hoursFromNow(50) },
    });
    assert("11. parent cannot create an event", parentCreateRes.status === 403, `status=${parentCreateRes.status}`);

    const assistantEditRes = await req(`/api/events/${eventA.id}`, {
      method: "PATCH",
      token: assistantCoachA.token,
      body: { title: "hijacked" },
    });
    const assistantCancelRes = await req(`/api/events/${eventA.id}`, {
      method: "PATCH",
      token: assistantCoachA.token,
      body: { status: "canceled" },
    });
    const assistantDeleteRes = await req(`/api/events/${eventA.id}`, { method: "DELETE", token: assistantCoachA.token });
    assert(
      "12. assistant coach cannot edit/cancel/delete",
      assistantEditRes.status === 403 && assistantCancelRes.status === 403 && assistantDeleteRes.status === 403,
      `edit=${assistantEditRes.status} cancel=${assistantCancelRes.status} delete=${assistantDeleteRes.status}`
    );

    const athleteEditRes = await req(`/api/events/${eventA.id}`, { method: "PATCH", token: athleteA.token, body: { title: "hijacked" } });
    const athleteCancelRes = await req(`/api/events/${eventA.id}`, { method: "PATCH", token: athleteA.token, body: { status: "canceled" } });
    const athleteDeleteRes = await req(`/api/events/${eventA.id}`, { method: "DELETE", token: athleteA.token });
    assert(
      "13. athlete cannot edit/cancel/delete",
      athleteEditRes.status === 403 && athleteCancelRes.status === 403 && athleteDeleteRes.status === 403,
      `edit=${athleteEditRes.status} cancel=${athleteCancelRes.status} delete=${athleteDeleteRes.status}`
    );

    const parentEditRes = await req(`/api/events/${eventA.id}`, { method: "PATCH", token: parentA.token, body: { title: "hijacked" } });
    const parentCancelRes = await req(`/api/events/${eventA.id}`, { method: "PATCH", token: parentA.token, body: { status: "canceled" } });
    const parentDeleteRes = await req(`/api/events/${eventA.id}`, { method: "DELETE", token: parentA.token });
    assert(
      "14. parent cannot edit/cancel/delete",
      parentEditRes.status === 403 && parentCancelRes.status === 403 && parentDeleteRes.status === 403,
      `edit=${parentEditRes.status} cancel=${parentCancelRes.status} delete=${parentDeleteRes.status}`
    );

    // ==================================================================
    // 15-20: Coach edit / cancel / delete lifecycle
    // ==================================================================

    const coachEditRes = await req(`/api/events/${eventA.id}`, {
      method: "PATCH",
      token: coachA.token,
      body: { title: `${RUN_TAG} Practice (edited)`, location: "Auxiliary Gym" },
    });
    assert(
      "15. coach can edit an event",
      coachEditRes.status === 200 && coachEditRes.data.title === `${RUN_TAG} Practice (edited)`,
      JSON.stringify(coachEditRes.data)
    );

    const coachCancelRes = await req(`/api/events/${eventA.id}`, {
      method: "PATCH",
      token: coachA.token,
      body: { status: "canceled" },
    });
    assert(
      "16. coach can cancel an event",
      coachCancelRes.status === 200 && coachCancelRes.data.status === "canceled",
      JSON.stringify(coachCancelRes.data)
    );

    const listAfterCancelRes = await req(`/api/teams/${teamA.id}/events`, { token: coachA.token });
    const canceledStillListed = listAfterCancelRes.data?.find((e) => e.id === eventA.id);
    assert(
      "17. canceled event remains in Schedule with canceled status (not hidden)",
      canceledStillListed && canceledStillListed.status === "canceled",
      JSON.stringify(canceledStillListed)
    );

    // Delete lifecycle uses a SEPARATE event so the canceled one above
    // stays intact for the Home "canceled doesn't consume a slot" test below.
    const toDeleteRes = await req(`/api/teams/${teamA.id}/events`, {
      method: "POST",
      token: coachA.token,
      body: { event_type: "other", title: `${RUN_TAG} accidental event`, starts_at: hoursFromNow(60) },
    });
    const toDelete = toDeleteRes.data;

    const deleteRes = await req(`/api/events/${toDelete.id}`, { method: "DELETE", token: coachA.token });
    assert("19. coach can permanently delete an event", deleteRes.status === 200, `status=${deleteRes.status}`);

    const getAfterDeleteRes = await req(`/api/events/${toDelete.id}`, { token: coachA.token });
    const listAfterDeleteRes = await req(`/api/teams/${teamA.id}/events`, { token: coachA.token });
    const stillInList = listAfterDeleteRes.data?.some((e) => e.id === toDelete.id);
    assert(
      "20. deleted event disappears everywhere",
      getAfterDeleteRes.status === 404 && stillInList === false,
      `get=${getAfterDeleteRes.status} stillInList=${stillInList}`
    );

    // ==================================================================
    // 21: Revoked membership immediately removes Schedule access
    // ==================================================================

    const revokeRes = await req(`/api/teams/${teamA.id}/members/${athleteA.id}`, { method: "DELETE", token: coachA.token });
    assert("setup: revoke athleteA from Team A", revokeRes.status === 200, `status=${revokeRes.status}`);

    const revokedListRes = await req(`/api/teams/${teamA.id}/events`, { token: athleteA.token });
    const revokedGetRes = await req(`/api/events/${eventA.id}`, { token: athleteA.token });
    assert(
      "21. revoked membership immediately removes Schedule access (list + detail)",
      revokedListRes.status === 403 && revokedGetRes.status === 403,
      `list=${revokedListRes.status} get=${revokedGetRes.status}`
    );

    // ==================================================================
    // 22-24: Multi-team retrieval + "All Teams" (client-merges authorized
    // per-team calls -- proven here by the underlying per-team guarantees)
    // ==================================================================

    const multiTeamAListRes = await req(`/api/teams/${teamA.id}/events`, { token: multiTeamUser.token });
    const multiTeamBListRes = await req(`/api/teams/${teamB.id}/events`, { token: multiTeamUser.token });
    assert(
      "22. multi-team user can retrieve events from every active team they belong to",
      multiTeamAListRes.status === 200 && multiTeamBListRes.status === 200,
      `A=${multiTeamAListRes.status} B=${multiTeamBListRes.status}`
    );

    const multiTeamCListRes = await req(`/api/teams/${teamC.id}/events`, { token: multiTeamUser.token });
    assert(
      "23. multi-team user cannot retrieve events from a team they don't belong to",
      multiTeamCListRes.status === 403,
      `status=${multiTeamCListRes.status}`
    );
    // 24: "All Teams" is implemented client-side as merged results from
    // the per-team endpoint above -- 22/23 together ARE the server-side
    // proof that such a merge would only ever combine authorized teams.

    // ==================================================================
    // 25-31: Home (GET /api/users/:id/upcoming-events)
    // ==================================================================

    // Clear any prior events created above that might land in the
    // window this section tests, by using a fresh, distinctly-tagged
    // batch at controlled offsets.
    const homeEvents = [];
    const homeSpecs = [
      { team: teamA, hours: 10, title: `${RUN_TAG} home-1 (earliest, Team A)` },
      { team: teamB, hours: 20, title: `${RUN_TAG} home-2 (Team B)` },
      { team: teamA, hours: 30, title: `${RUN_TAG} home-3 (Team A)` },
      { team: teamA, hours: 40, title: `${RUN_TAG} home-4 (Team A, should NOT be in top 3)` },
      { team: teamB, hours: 15, title: `${RUN_TAG} home-canceled (Team B, canceled, must not count)` },
    ];
    for (const spec of homeSpecs) {
      const token = spec.team.id === teamA.id ? coachA.token : coachB.token;
      const r = await req(`/api/teams/${spec.team.id}/events`, {
        method: "POST",
        token,
        body: { event_type: "practice", title: spec.title, starts_at: hoursFromNow(spec.hours) },
      });
      homeEvents.push({ ...spec, id: r.data.id });
      created.eventIds.push(r.data.id);
    }
    // Cancel the "must not count" one.
    const canceledHomeEvent = homeEvents.find((e) => e.title.includes("canceled"));
    await req(`/api/events/${canceledHomeEvent.id}`, {
      method: "PATCH",
      token: coachB.token,
      body: { status: "canceled" },
    });

    const homeRes = await req(`/api/users/${multiTeamUser.id}/upcoming-events`, { token: multiTeamUser.token });
    assert("25. Home combines upcoming events across all active teams", homeRes.status === 200, `status=${homeRes.status}`);

    const homeTitles = (homeRes.data || []).map((e) => e.title);
    assert(
      "26. Home sorts globally by starts_at ASC",
      JSON.stringify(homeRes.data?.map((e) => e.starts_at)) ===
        JSON.stringify([...(homeRes.data || [])].sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at)).map((e) => e.starts_at)),
      JSON.stringify(homeTitles)
    );

    assert("27. Home returns only the next 3", homeRes.data?.length === 3, `count=${homeRes.data?.length}`);

    const top3AreEarliestThree = homeTitles.every((t) => t.includes("home-1") || t.includes("home-2") || t.includes("home-3"));
    assert(
      "28. Home does not reserve slots per team (top 3 by time can be dominated by one team)",
      top3AreEarliestThree,
      JSON.stringify(homeTitles)
    );

    assert(
      "28b. canceled event never occupies a Home next-three slot",
      !homeTitles.some((t) => t.includes("canceled")),
      JSON.stringify(homeTitles)
    );

    assert(
      "29. Home event results include team identity",
      (homeRes.data || []).every((e) => Boolean(e.team_name) && Boolean(e.team_id)),
      JSON.stringify(homeRes.data)
    );

    // 30: revoking Team B membership removes Team B's events from Home.
    const revokeMultiTeamBRes = await req(`/api/teams/${teamB.id}/members/${multiTeamUser.id}`, {
      method: "DELETE",
      token: coachB.token,
    });
    assert("setup: revoke multiTeamUser from Team B", revokeMultiTeamBRes.status === 200, `status=${revokeMultiTeamBRes.status}`);

    const homeAfterRevokeRes = await req(`/api/users/${multiTeamUser.id}/upcoming-events`, { token: multiTeamUser.token });
    const stillHasTeamBEvent = (homeAfterRevokeRes.data || []).some((e) => e.team_id === teamB.id);
    assert(
      "30. revoking team membership immediately removes that team's events from Home",
      stillHasTeamBEvent === false,
      JSON.stringify(homeAfterRevokeRes.data)
    );

    // 31: editing an event that lands in the next-three is reflected in Home.
    const nowEarliest = homeAfterRevokeRes.data?.[0];
    if (nowEarliest) {
      const editForHomeRes = await req(`/api/events/${nowEarliest.id}`, {
        method: "PATCH",
        token: coachA.token,
        body: { title: `${RUN_TAG} edited-for-home-check` },
      });
      const homeAfterEditRes = await req(`/api/users/${multiTeamUser.id}/upcoming-events`, { token: multiTeamUser.token });
      const editReflected = (homeAfterEditRes.data || []).some((e) => e.title === `${RUN_TAG} edited-for-home-check`);
      assert(
        "31. editing an event is reflected in Home when it belongs in the next three",
        editForHomeRes.status === 200 && editReflected,
        `editStatus=${editForHomeRes.status} reflected=${editReflected}`
      );
    } else {
      assert("31. editing an event is reflected in Home when it belongs in the next three", false, "no earliest event found to edit");
    }

    // ==================================================================
    // 32-33: Time / timezone round-trip integrity
    // ==================================================================

    const explicitOffsetTime = "2026-09-01T23:30:00-04:00"; // 11:30pm US Eastern
    const expectedUtcInstant = new Date(explicitOffsetTime).toISOString();

    const tzEventRes = await req(`/api/teams/${teamA.id}/events`, {
      method: "POST",
      token: coachA.token,
      body: { event_type: "other", title: `${RUN_TAG} tz-check`, starts_at: explicitOffsetTime },
    });
    created.eventIds.push(tzEventRes.data.id);

    const tzReloadRes = await req(`/api/events/${tzEventRes.data.id}`, { token: coachA.token });
    assert(
      "32. event time survives save/reload as the exact same instant",
      new Date(tzReloadRes.data.starts_at).toISOString() === expectedUtcInstant,
      `stored=${tzReloadRes.data.starts_at} expected=${expectedUtcInstant}`
    );
    assert(
      "33. no unexpected date-boundary shift across timezone conversion (server contract: the absolute instant is preserved exactly)",
      new Date(tzReloadRes.data.starts_at).getTime() === new Date(explicitOffsetTime).getTime(),
      `stored=${tzReloadRes.data.starts_at}`
    );

    // ==================================================================
    // Additional edge case discovered during implementation: invalid
    // event_type and missing required fields are rejected with 400, not
    // a raw DB constraint error (500).
    // ==================================================================

    const badTypeRes = await req(`/api/teams/${teamA.id}/events`, {
      method: "POST",
      token: coachA.token,
      body: { event_type: "wrestling_weigh_in", title: "bad type", starts_at: hoursFromNow(1) },
    });
    assert("edge: invalid event_type rejected with 400, not 500", badTypeRes.status === 400, `status=${badTypeRes.status}`);

    const missingTitleRes = await req(`/api/teams/${teamA.id}/events`, {
      method: "POST",
      token: coachA.token,
      body: { event_type: "practice", starts_at: hoursFromNow(1) },
    });
    assert("edge: missing title rejected with 400", missingTitleRes.status === 400, `status=${missingTitleRes.status}`);

    const endBeforeStartRes = await req(`/api/teams/${teamA.id}/events`, {
      method: "POST",
      token: coachA.token,
      body: {
        event_type: "practice",
        title: "bad range",
        starts_at: hoursFromNow(10),
        ends_at: hoursFromNow(5),
      },
    });
    assert("edge: ends_at before starts_at rejected with 400", endBeforeStartRes.status === 400, `status=${endBeforeStartRes.status}`);
  } finally {
    try {
      for (const id of created.eventIds) {
        await client.query("DELETE FROM events WHERE id = $1", [id]);
      }
      // Belt-and-suspenders: remove ANY event this run's teams still hold,
      // in case an assertion path created one not individually tracked.
      for (const id of created.teamIds) {
        await client.query("DELETE FROM events WHERE team_id = $1", [id]);
      }
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
        await client.query("DELETE FROM events WHERE created_by = $1", [id]);
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
