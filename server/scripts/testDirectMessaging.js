/*
  testDirectMessaging.js — Direct Messaging acceptance script. Same shape
  as testSchedule.js: plain Node, real app on a throwaway local port, real
  fetch() calls, RUN_TAG-namespaced rows, full cleanup in a finally block
  regardless of pass/fail, direct-insert-plus-hand-signed-JWT for every
  test user (registerLimiter budget reasons, same as testSchedule.js).

  parent_athlete_links rows are inserted directly via SQL for test setup
  -- there is no route to create them in this branch by design (Roster
  Profiles' job), so this is the only way to exercise the parent/athlete
  eligibility rules at all right now.

  Run by hand: ALLOW_PRODUCTION_TESTS=true node server/scripts/testDirectMessaging.js
*/

require("dotenv").config();

const { requireProductionTestOptIn } = require("./lib/requireProductionTestOptIn");
requireProductionTestOptIn("testDirectMessaging.js");

const jwt = require("jsonwebtoken");

const app = require("../app");
const client = require("../db/client");

const PORT = 3976;
const BASE_URL = `http://localhost:${PORT}`;
const RUN_TAG = `dm_${Date.now()}`;

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

async function linkParentAthlete(parentId, athleteId) {
  const result = await client.query(
    `INSERT INTO parent_athlete_links (parent_user_id, athlete_user_id) VALUES ($1, $2) RETURNING id`,
    [parentId, athleteId]
  );
  return result.rows[0].id;
}

async function openDM(token, recipientUserId) {
  return req("/api/direct-messages", { method: "POST", token, body: { recipient_user_id: recipientUserId } });
}

function unreadFor(conversations, conversationId) {
  const row = conversations.find((c) => c.id === conversationId);
  return row ? Number(row.unread_count) : undefined;
}

async function main() {
  const created = { userIds: [], teamIds: [], linkIds: [], conversationIds: [] };
  const server = app.listen(PORT);

  try {
    // ==================================================================
    // Setup: two teams, full roster on Team A, a linked parent/athlete
    // pair, an unlinked parent, a multi-team user, outsiders.
    // ==================================================================

    const coachA = await createTestUser(`${RUN_TAG}-coachA@test.cresamor.local`, "coach");
    created.userIds.push(coachA.id);
    const teamARes = await req("/api/teams", {
      method: "POST",
      token: coachA.token,
      body: { name: `${RUN_TAG} Team A`, sport: "Wrestling" },
    });
    const teamA = teamARes.data;
    created.teamIds.push(teamA.id);

    const coachB = await createTestUser(`${RUN_TAG}-coachB@test.cresamor.local`, "coach");
    created.userIds.push(coachB.id);
    const teamBRes = await req("/api/teams", {
      method: "POST",
      token: coachB.token,
      body: { name: `${RUN_TAG} Team B`, sport: "Track" },
    });
    const teamB = teamBRes.data;
    created.teamIds.push(teamB.id);

    const assistantCoachA = await createTestUser(`${RUN_TAG}-assistantA@test.cresamor.local`, "athlete");
    created.userIds.push(assistantCoachA.id);
    await req(`/api/users/${assistantCoachA.id}/teams`, {
      method: "POST",
      token: coachA.token,
      body: { team_id: teamA.id, role_on_team: "assistant_coach" },
    });

    const athleteA1 = await createTestUser(`${RUN_TAG}-athleteA1@test.cresamor.local`, "athlete");
    created.userIds.push(athleteA1.id);
    await req(`/api/users/${athleteA1.id}/teams`, {
      method: "POST",
      token: coachA.token,
      body: { team_id: teamA.id, role_on_team: "athlete" },
    });

    const athleteA2 = await createTestUser(`${RUN_TAG}-athleteA2@test.cresamor.local`, "athlete");
    created.userIds.push(athleteA2.id);
    await req(`/api/users/${athleteA2.id}/teams`, {
      method: "POST",
      token: coachA.token,
      body: { team_id: teamA.id, role_on_team: "athlete" },
    });

    // Unlinked parent — on the Team A roster, but no parent_athlete_links
    // row at all. Proves the "safe-empty, not broadly open" guarantee.
    const parentUnlinked = await createTestUser(`${RUN_TAG}-parentUnlinked@test.cresamor.local`, "parent");
    created.userIds.push(parentUnlinked.id);
    await req(`/api/users/${parentUnlinked.id}/teams`, {
      method: "POST",
      token: coachA.token,
      body: { team_id: teamA.id, role_on_team: "parent" },
    });

    // Linked parent/athlete pair.
    const parentLinked = await createTestUser(`${RUN_TAG}-parentLinked@test.cresamor.local`, "parent");
    created.userIds.push(parentLinked.id);
    const athleteLinked = await createTestUser(`${RUN_TAG}-athleteLinked@test.cresamor.local`, "athlete");
    created.userIds.push(athleteLinked.id);
    await req(`/api/users/${athleteLinked.id}/teams`, {
      method: "POST",
      token: coachA.token,
      body: { team_id: teamA.id, role_on_team: "athlete" },
    });
    const linkId = await linkParentAthlete(parentLinked.id, athleteLinked.id);
    created.linkIds.push(linkId);

    const outsider = await createTestUser(`${RUN_TAG}-outsider@test.cresamor.local`, "athlete");
    created.userIds.push(outsider.id);

    const platformAdminOutsider = await createTestUser(
      `${RUN_TAG}-platformadmin@test.cresamor.local`,
      "coach",
      true
    );
    created.userIds.push(platformAdminOutsider.id);

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

    // Team A's and Team B's auto-created team conversations (POST /api/teams
    // makes one automatically).
    const teamAConvRes = await req("/api/conversations", { token: coachA.token });
    const teamAConversation = teamAConvRes.data.find((c) => c.team_id === teamA.id && c.category === "team");
    const teamBConvRes = await req("/api/conversations", { token: coachB.token });
    const teamBConversation = teamBConvRes.data.find((c) => c.team_id === teamB.id && c.category === "team");

    // ==================================================================
    // A. TEAM CHAT REGRESSION
    // ==================================================================

    const teamACoachList = await req("/api/conversations", { token: coachA.token });
    assert(
      "A1. Team A coach's conversation list does not include Team B chat",
      !teamACoachList.data.some((c) => c.id === teamBConversation.id),
      `ids=${teamACoachList.data.map((c) => c.id).join(",")}`
    );

    const teamBMessagesFromA = await req(`/api/conversations/${teamBConversation.id}/messages`, {
      token: coachA.token,
    });
    assert(
      "A2. Team A coach cannot read Team B chat messages",
      teamBMessagesFromA.status === 403,
      `status=${teamBMessagesFromA.status}`
    );

    const revokeRes = await req(`/api/teams/${teamA.id}/members/${athleteA1.id}`, {
      method: "DELETE",
      token: coachA.token,
    });
    assert("setup: revoke athleteA1 from Team A", revokeRes.status === 200, `status=${revokeRes.status}`);

    const revokedTeamChat = await req(`/api/conversations/${teamAConversation.id}/messages`, {
      token: athleteA1.token,
    });
    assert(
      "A3. revoked team member immediately loses Team Chat access",
      revokedTeamChat.status === 403,
      `status=${revokedTeamChat.status}`
    );

    const multiTeamList = await req("/api/conversations", { token: multiTeamUser.token });
    assert(
      "A4. multi-team user's conversation list includes both Team A and Team B chat",
      multiTeamList.data.some((c) => c.id === teamAConversation.id) &&
        multiTeamList.data.some((c) => c.id === teamBConversation.id),
      `ids=${multiTeamList.data.map((c) => c.id).join(",")}`
    );

    const adminTeamChat = await req(`/api/conversations/${teamAConversation.id}/messages`, {
      token: platformAdminOutsider.token,
    });
    assert(
      "A5. Platform Admin with no Team A membership gets no Team Chat bypass",
      adminTeamChat.status === 403,
      `status=${adminTeamChat.status}`
    );

    // ==================================================================
    // B. DM ISOLATION
    // ==================================================================

    const dmCreate = await openDM(coachA.token, athleteA2.id);
    assert("B1. eligible pair can open a DM", dmCreate.status === 201, `status=${dmCreate.status}`);
    const dmAB = dmCreate.data;
    created.conversationIds.push(dmAB.id);

    const dmReadByParticipant = await req(`/api/conversations/${dmAB.id}/messages`, { token: athleteA2.token });
    assert("B2. participant can read the DM", dmReadByParticipant.status === 200, `status=${dmReadByParticipant.status}`);

    const dmSendByParticipant = await req(`/api/conversations/${dmAB.id}/messages`, {
      method: "POST",
      token: coachA.token,
      body: { body: `${RUN_TAG} hello` },
    });
    assert("B3. participant can send in the DM", dmSendByParticipant.status === 201, `status=${dmSendByParticipant.status}`);

    const dmReadByOutsider = await req(`/api/conversations/${dmAB.id}/messages`, { token: outsider.token });
    assert("B4. unrelated user cannot read the DM", dmReadByOutsider.status === 403, `status=${dmReadByOutsider.status}`);

    const dmSendByOutsider = await req(`/api/conversations/${dmAB.id}/messages`, {
      method: "POST",
      token: outsider.token,
      body: { body: "should not work" },
    });
    assert("B5. unrelated user cannot send in the DM", dmSendByOutsider.status === 403, `status=${dmSendByOutsider.status}`);

    const guessedId = dmAB.id + 1;
    if (!created.conversationIds.includes(guessedId)) {
      const guessedRes = await req(`/api/conversations/${guessedId}/messages`, { token: outsider.token });
      assert(
        "B6. a guessed adjacent conversation id does not leak access",
        guessedRes.status === 403 || guessedRes.status === 404,
        `status=${guessedRes.status}`
      );
    }

    const adminReadDM = await req(`/api/conversations/${dmAB.id}/messages`, { token: platformAdminOutsider.token });
    assert(
      "B7. Platform Admin cannot read an unrelated private DM",
      adminReadDM.status === 403,
      `status=${adminReadDM.status}`
    );

    // ==================================================================
    // C. RECIPIENT ELIGIBILITY
    // ==================================================================

    const coachEligible = await req("/api/messages/eligible-recipients", { token: coachA.token });
    assert(
      "C1. coach's eligible recipients include their team roster",
      coachEligible.data.some((r) => r.id === athleteA2.id) &&
        coachEligible.data.some((r) => r.id === assistantCoachA.id) &&
        coachEligible.data.some((r) => r.id === parentUnlinked.id),
      `ids=${coachEligible.data.map((r) => r.id).join(",")}`
    );

    const athleteEligible = await req("/api/messages/eligible-recipients", { token: athleteA2.token });
    assert(
      "C2. athlete's eligible recipients include coach/assistant coach but not an unrelated teammate",
      athleteEligible.data.some((r) => r.id === coachA.id) &&
        athleteEligible.data.some((r) => r.id === assistantCoachA.id) &&
        !athleteEligible.data.some((r) => r.id === parentUnlinked.id),
      `ids=${athleteEligible.data.map((r) => r.id).join(",")}`
    );

    const parentUnlinkedEligible = await req("/api/messages/eligible-recipients", { token: parentUnlinked.token });
    assert(
      "C3. unlinked parent has ZERO eligible recipients (safe-empty, not broadly open)",
      parentUnlinkedEligible.data.length === 0,
      `ids=${parentUnlinkedEligible.data.map((r) => r.id).join(",")}`
    );

    const parentLinkedEligible = await req("/api/messages/eligible-recipients", { token: parentLinked.token });
    assert(
      "C4. linked parent's eligible recipients include their athlete AND that athlete's coaching staff",
      parentLinkedEligible.data.some((r) => r.id === athleteLinked.id) &&
        parentLinkedEligible.data.some((r) => r.id === coachA.id) &&
        parentLinkedEligible.data.some((r) => r.id === assistantCoachA.id),
      `ids=${parentLinkedEligible.data.map((r) => r.id).join(",")}`
    );

    const athleteLinkedEligible = await req("/api/messages/eligible-recipients", { token: athleteLinked.token });
    assert(
      "C5. linked athlete's eligible recipients include their parent",
      athleteLinkedEligible.data.some((r) => r.id === parentLinked.id),
      `ids=${athleteLinkedEligible.data.map((r) => r.id).join(",")}`
    );

    const crossPairAttempt = await openDM(parentUnlinked.token, athleteA2.id);
    assert(
      "C6. unrelated parent cannot open a DM with an unrelated athlete on the same team",
      crossPairAttempt.status === 403,
      `status=${crossPairAttempt.status}`
    );

    // Asymmetric-but-still-two-way: the Coach's own broad reach to their
    // whole roster is preserved (parentUnlinked is on Team A's roster,
    // no link needed for the COACH to reach them) -- but per C3 above,
    // that same unlinked parent has no standing to initiate the reverse.
    // Once the coach legitimately opens it though, the parent must be
    // able to read and reply, or this would be a one-way mailbox.
    const parentUnlinkedCannotInitiate = await openDM(parentUnlinked.token, coachA.id);
    assert(
      "C5b. an unlinked parent still cannot INITIATE a DM with their team's coach",
      parentUnlinkedCannotInitiate.status === 403,
      `status=${parentUnlinkedCannotInitiate.status}`
    );

    const coachInitiatesToUnlinkedParent = await openDM(coachA.token, parentUnlinked.id);
    assert(
      "C5c. the Coach's own broad roster reach is preserved: Coach CAN initiate with an unlinked parent",
      coachInitiatesToUnlinkedParent.status === 201,
      `status=${coachInitiatesToUnlinkedParent.status}`
    );
    if (coachInitiatesToUnlinkedParent.status === 201) {
      created.conversationIds.push(coachInitiatesToUnlinkedParent.data.id);

      const parentReadsIt = await req(`/api/conversations/${coachInitiatesToUnlinkedParent.data.id}/messages`, {
        token: parentUnlinked.token,
      });
      assert(
        "C5d. once the Coach opens it, the unlinked parent CAN read/reply (not a one-way mailbox)",
        parentReadsIt.status === 200,
        `status=${parentReadsIt.status}`
      );

      const parentReplies = await req(`/api/conversations/${coachInitiatesToUnlinkedParent.data.id}/messages`, {
        method: "POST",
        token: parentUnlinked.token,
        body: { body: `${RUN_TAG} parent reply` },
      });
      assert(
        "C5e. the unlinked parent can send a reply in that coach-initiated thread",
        parentReplies.status === 201,
        `status=${parentReplies.status}`
      );
    }

    const athleteToAthleteAttempt = await openDM(athleteA2.token, athleteLinked.id);
    assert(
      "C7. two athletes on the same team cannot DM each other absent any other relationship",
      athleteToAthleteAttempt.status === 403,
      `status=${athleteToAthleteAttempt.status}`
    );

    // Revoke the link and confirm eligibility disappears live.
    await client.query("UPDATE parent_athlete_links SET revoked_at = now() WHERE id = $1", [linkId]);
    const revokedLinkEligible = await req("/api/messages/eligible-recipients", { token: parentLinked.token });
    assert(
      "C8. revoking a parent_athlete_links row removes eligibility live",
      !revokedLinkEligible.data.some((r) => r.id === athleteLinked.id),
      `ids=${revokedLinkEligible.data.map((r) => r.id).join(",")}`
    );
    // Restore it — later assertions (D/E) still exercise the linked pair.
    await client.query("UPDATE parent_athlete_links SET revoked_at = NULL WHERE id = $1", [linkId]);

    // ==================================================================
    // D. CANONICAL THREADS
    // ==================================================================

    const dmRepeat1 = await openDM(coachA.token, athleteA2.id);
    const dmRepeat2 = await openDM(coachA.token, athleteA2.id);
    assert(
      "D1. repeated open/create returns the same conversation",
      dmRepeat1.data.id === dmAB.id && dmRepeat2.data.id === dmAB.id,
      `ids=${dmRepeat1.data.id},${dmRepeat2.data.id} vs original=${dmAB.id}`
    );

    const dmReversed = await openDM(athleteA2.token, coachA.id);
    assert(
      "D2. reversed user order resolves to the same conversation",
      dmReversed.data.id === dmAB.id,
      `id=${dmReversed.data.id} vs original=${dmAB.id}`
    );

    const raceResults = await Promise.all(
      Array.from({ length: 6 }, () => openDM(parentLinked.token, athleteLinked.id))
    );
    const raceIds = new Set(raceResults.map((r) => r.data.id));
    assert(
      "D3. concurrent/racing creation attempts for the same pair all resolve to one conversation",
      raceIds.size === 1 && raceResults.every((r) => r.status === 200 || r.status === 201),
      `distinctIds=${raceIds.size}, statuses=${raceResults.map((r) => r.status).join(",")}`
    );
    created.conversationIds.push(...raceIds);

    // ==================================================================
    // E. UNREAD STATE
    // ==================================================================

    const dmParentAthlete = raceResults[0].data;

    const beforeSend = await req("/api/conversations", { token: athleteLinked.token });
    const unreadBefore = unreadFor(beforeSend.data, dmParentAthlete.id) || 0;

    await req(`/api/conversations/${dmParentAthlete.id}/messages`, {
      method: "POST",
      token: parentLinked.token,
      body: { body: `${RUN_TAG} msg 1` },
    });
    await req(`/api/conversations/${dmParentAthlete.id}/messages`, {
      method: "POST",
      token: parentLinked.token,
      body: { body: `${RUN_TAG} msg 2` },
    });
    await req(`/api/conversations/${dmParentAthlete.id}/messages`, {
      method: "POST",
      token: parentLinked.token,
      body: { body: `${RUN_TAG} msg 3` },
    });

    const recipientView = await req("/api/conversations", { token: athleteLinked.token });
    assert(
      "E1/E5. new messages create an accurate per-thread unread count for the recipient",
      unreadFor(recipientView.data, dmParentAthlete.id) === unreadBefore + 3,
      `unread=${unreadFor(recipientView.data, dmParentAthlete.id)} expected=${unreadBefore + 3}`
    );

    const senderView = await req("/api/conversations", { token: parentLinked.token });
    assert(
      "E2. the sender's own view of the thread shows zero unread from their own messages",
      unreadFor(senderView.data, dmParentAthlete.id) === 0,
      `unread=${unreadFor(senderView.data, dmParentAthlete.id)}`
    );

    // Background polling (a plain GET of messages) must NOT mark read.
    await req(`/api/conversations/${dmParentAthlete.id}/messages`, { token: athleteLinked.token });
    const afterBackgroundFetch = await req("/api/conversations", { token: athleteLinked.token });
    assert(
      "E3/E7. fetching messages alone (background polling) does not mark the thread read",
      unreadFor(afterBackgroundFetch.data, dmParentAthlete.id) === unreadBefore + 3,
      `unread=${unreadFor(afterBackgroundFetch.data, dmParentAthlete.id)}`
    );

    await req(`/api/conversations/${dmParentAthlete.id}/read`, { method: "PUT", token: athleteLinked.token });
    const afterMarkRead = await req("/api/conversations", { token: athleteLinked.token });
    assert(
      "E4. explicitly marking read (an actual view) zeroes the thread's unread count",
      unreadFor(afterMarkRead.data, dmParentAthlete.id) === 0,
      `unread=${unreadFor(afterMarkRead.data, dmParentAthlete.id)}`
    );

    // Nav badge aggregation: sum unread_count across every conversation
    // the polling infrastructure already returns — no separate endpoint.
    await req(`/api/conversations/${dmParentAthlete.id}/messages`, {
      method: "POST",
      token: parentLinked.token,
      body: { body: `${RUN_TAG} msg 4 (post mark-read)` },
    });
    const badgeView = await req("/api/conversations", { token: athleteLinked.token });
    const badgeTotal = badgeView.data.reduce((sum, c) => sum + Number(c.unread_count || 0), 0);
    assert(
      "E6. nav badge total (sum of per-thread unread_count) reflects the new message",
      badgeTotal >= 1,
      `total=${badgeTotal}`
    );

    // E8: revoke the link again and confirm the conversation (and its
    // unread contribution) drops out of the badge/inbox entirely, without
    // deleting any message history.
    await client.query("UPDATE parent_athlete_links SET revoked_at = now() WHERE id = $1", [linkId]);
    const afterRevokeView = await req("/api/conversations", { token: athleteLinked.token });
    assert(
      "E8. a conversation whose relationship was revoked no longer contributes to the badge/inbox",
      !afterRevokeView.data.some((c) => c.id === dmParentAthlete.id),
      `ids=${afterRevokeView.data.map((c) => c.id).join(",")}`
    );
    const historyStillExists = await client.query("SELECT COUNT(*) FROM messages WHERE conversation_id = $1", [
      dmParentAthlete.id,
    ]);
    assert(
      "E8b. message history is preserved (not deleted) despite the access change",
      Number(historyStillExists.rows[0].count) >= 4,
      `count=${historyStillExists.rows[0].count}`
    );
    await client.query("UPDATE parent_athlete_links SET revoked_at = NULL WHERE id = $1", [linkId]);

    // ==================================================================
    // F. MULTI-TEAM
    // ==================================================================

    const multiTeamDM = await openDM(multiTeamUser.token, coachB.id);
    assert("F1. multi-team user can open a DM via their Team B relationship", multiTeamDM.status === 201, `status=${multiTeamDM.status}`);
    created.conversationIds.push(multiTeamDM.data.id);

    const revokeFromB = await req(`/api/teams/${teamB.id}/members/${multiTeamUser.id}`, {
      method: "DELETE",
      token: coachB.token,
    });
    assert("setup: revoke multiTeamUser from Team B only", revokeFromB.status === 200, `status=${revokeFromB.status}`);

    const teamAStillWorks = await req("/api/conversations", { token: multiTeamUser.token });
    assert(
      "F2. revoking Team B does not remove Team A access via the other, still-valid relationship",
      teamAStillWorks.data.some((c) => c.id === teamAConversation.id),
      `ids=${teamAStillWorks.data.map((c) => c.id).join(",")}`
    );

    const teamBDmNowBlocked = await req(`/api/conversations/${multiTeamDM.data.id}/messages`, {
      token: multiTeamUser.token,
    });
    assert(
      "F3. the Team-B-derived DM access is gone after that specific revocation",
      teamBDmNowBlocked.status === 403,
      `status=${teamBDmNowBlocked.status}`
    );

    // ==================================================================
    // G. SECURITY
    // ==================================================================

    const nonexistentTarget = await openDM(coachA.token, 999999999);
    assert(
      "G1. a nonexistent recipient id is rejected the same way as an ineligible real one (no enumeration signal)",
      nonexistentTarget.status === 403,
      `status=${nonexistentTarget.status}`
    );

    const selfDm = await openDM(coachA.token, coachA.id);
    assert("G2. cannot open a DM with yourself", selfDm.status === 400, `status=${selfDm.status}`);

    const noRecipientsLeakOutsider = await req("/api/messages/eligible-recipients", { token: coachA.token });
    assert(
      "G3. eligible-recipients never includes a fully unrelated outsider",
      !noRecipientsLeakOutsider.data.some((r) => r.id === outsider.id),
      `ids=${noRecipientsLeakOutsider.data.map((r) => r.id).join(",")}`
    );
  } finally {
    try {
      const conversationIds = [...new Set(created.conversationIds)];
      for (const id of conversationIds) {
        await client.query("DELETE FROM messages WHERE conversation_id = $1", [id]);
        await client.query("DELETE FROM conversation_participants WHERE conversation_id = $1", [id]);
        await client.query("DELETE FROM conversations WHERE id = $1", [id]);
      }
      for (const id of created.linkIds) {
        await client.query("DELETE FROM parent_athlete_links WHERE id = $1", [id]);
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
        await client.query("DELETE FROM parent_athlete_links WHERE parent_user_id = $1 OR athlete_user_id = $1", [id]);
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
