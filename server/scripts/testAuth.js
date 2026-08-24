/*
  testAuth.js — Beta Readiness Sprint 2 acceptance script. Plain Node, no
  test-framework dependency (consistent with this project's minimal-
  dependency philosophy). Spins up the real app on a throwaway local port,
  drives it over HTTP with real requests (not unit-testing handlers in
  isolation), and asserts the acceptance criteria from the sprint plan.

  Run by hand: node server/scripts/testAuth.js
  Requires the same env vars the app normally needs (.env / dotenv) — it
  runs against whatever DATABASE_URL is configured, so it creates clearly-
  namespaced test users/teams/videos and deletes every row it created in a
  finally block, regardless of pass/fail. Not wired into npm start/dev.
*/

require("dotenv").config();

const { requireProductionTestOptIn } = require("./lib/requireProductionTestOptIn");
requireProductionTestOptIn("testAuth.js");

const jwt = require("jsonwebtoken");

const app = require("../app");
const client = require("../db/client");
const storage = require("../services/storage/storage");

const PORT = 3999;
const BASE_URL = `http://localhost:${PORT}`;
const RUN_TAG = `authsprint2_${Date.now()}`;

const results = [];

function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
}

function assert(name, condition, detail) {
  record(name, Boolean(condition), detail);
}

async function req(path, { method = "GET", token, body, isForm } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body && !isForm) headers["Content-Type"] = "application/json";

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: isForm ? body : body ? JSON.stringify(body) : undefined,
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
  const created = {
    userIds: [],
    teamIds: [],
    videoIds: [],
    clipIds: [],
    messageIds: [],
  };

  const server = app.listen(PORT);

  try {
    // ---- Registration / login ----
    const coach = await registerUser(`${RUN_TAG}_coach@test.cresamor.local`, "coach");
    const athlete1 = await registerUser(`${RUN_TAG}_athlete1@test.cresamor.local`, "athlete");
    const athlete2 = await registerUser(`${RUN_TAG}_athlete2@test.cresamor.local`, "athlete");
    created.userIds.push(coach.user.id, athlete1.user.id, athlete2.user.id);

    // 1. Valid login issues a usable token.
    const loginResult = await req("/api/auth/login", {
      method: "POST",
      body: { email: `${RUN_TAG}_coach@test.cresamor.local`, password: "TestPass123!" },
    });
    const loginCheck = await req("/api/teams", { token: loginResult.data?.token });
    assert("valid login issues a usable token", loginResult.status === 200 && loginCheck.status === 200);

    // 2. Missing / invalid / expired / deleted-user token -> 401.
    const noToken = await req("/api/teams");
    assert("missing token -> 401", noToken.status === 401);

    const badToken = await req("/api/teams", { token: "not-a-real-token" });
    assert("invalid token -> 401", badToken.status === 401);

    const expiredToken = jwt.sign({ id: coach.user.id }, process.env.JWT_SECRET, { expiresIn: "-1s" });
    const expiredCheck = await req("/api/teams", { token: expiredToken });
    assert("expired token -> 401", expiredCheck.status === 401);

    const throwaway = await registerUser(`${RUN_TAG}_throwaway@test.cresamor.local`, "athlete");
    await client.query("DELETE FROM security_audit_log WHERE user_id = $1", [throwaway.user.id]);
    await client.query("DELETE FROM conversation_participants WHERE user_id = $1", [throwaway.user.id]);
    await client.query("DELETE FROM users WHERE id = $1", [throwaway.user.id]);
    const deletedUserCheck = await req("/api/teams", { token: throwaway.token });
    assert("deleted-user token -> 401", deletedUserCheck.status === 401);

    // ---- Team + membership setup ----
    const teamCreate = await req("/api/teams", {
      method: "POST",
      token: coach.token,
      body: { name: `${RUN_TAG}_team`, sport: "test" },
    });
    assert("coach can create a team", teamCreate.status === 201);
    const team = teamCreate.data;
    created.teamIds.push(team.id);

    const athleteCreateTeam = await req("/api/teams", {
      method: "POST",
      token: athlete1.token,
      body: { name: `${RUN_TAG}_should_not_exist`, sport: "test" },
    });
    // 4. Athlete blocked from a coach-only action.
    assert("athlete blocked from coach-only action (create team)", athleteCreateTeam.status === 403);

    const addAthlete1 = await req(`/api/users/${athlete1.user.id}/teams`, {
      method: "POST",
      token: coach.token,
      body: { team_id: team.id, role_on_team: "athlete" },
    });
    assert("coach can add a team member", addAthlete1.status === 201);

    // Role-escalation bug fix: non-coach cannot grant themselves a coach role.
    const selfEscalate = await req(`/api/users/${athlete2.user.id}/teams`, {
      method: "POST",
      token: athlete2.token,
      body: { team_id: team.id, role_on_team: "coach" },
    });
    assert("non-coach cannot self-grant a coach role_on_team", selfEscalate.status === 403);

    // Non-coach cannot manage someone else's membership at all.
    const otherManage = await req(`/api/users/${athlete1.user.id}/teams`, {
      method: "POST",
      token: athlete2.token,
      body: { team_id: team.id, role_on_team: "athlete" },
    });
    assert("non-coach cannot manage another user's team membership", otherManage.status === 403);

    // Non-coach CAN self-join with a non-coach role.
    const selfJoin = await req(`/api/users/${athlete2.user.id}/teams`, {
      method: "POST",
      token: athlete2.token,
      body: { team_id: team.id, role_on_team: "athlete" },
    });
    assert("non-coach can self-join with a non-coach role", selfJoin.status === 201);
    // athlete2 is intentionally now ALSO a team member — used below as the
    // "authorized team member can view" case; a separate truly-unrelated
    // user is registered for the "unrelated user is blocked" case.
    const outsider = await registerUser(`${RUN_TAG}_outsider@test.cresamor.local`, "athlete");
    created.userIds.push(outsider.user.id);

    // Coach granting a coach-level role_on_team — should succeed and be audit-logged.
    const grantCoachRole = await req(`/api/users/${athlete1.user.id}/teams`, {
      method: "POST",
      token: coach.token,
      body: { team_id: team.id, role_on_team: "coach" },
    });
    assert("coach can grant a coach-level role_on_team", grantCoachRole.status === 201);

    const roleGrantAudit = await client.query(
      "SELECT * FROM security_audit_log WHERE event_type = 'team_membership_changed' AND metadata->>'roleOnTeam' = 'coach' ORDER BY id DESC LIMIT 1"
    );
    assert("a role-granting team-membership change is audit-logged", roleGrantAudit.rows.length === 1);

    // ---- Video visibility + deletion ----
    const teamVideo = await client.query(
      `INSERT INTO videos (title, file_url, uploaded_by, team_id) VALUES ($1, $2, $3, $4) RETURNING *`,
      [`${RUN_TAG}_team_video`, "https://example.com/fake.mp4", coach.user.id, team.id]
    );
    created.videoIds.push(teamVideo.rows[0].id);

    // Separate row, deliberately outliving teamVideo (which gets deleted
    // below as part of the delete-permission test) — used only as a valid
    // FK target for the forged-clip test further down.
    const clipTestVideo = await client.query(
      `INSERT INTO videos (title, file_url, uploaded_by, team_id) VALUES ($1, $2, $3, $4) RETURNING *`,
      [`${RUN_TAG}_clip_test_video`, "https://example.com/fake2.mp4", coach.user.id, team.id]
    );
    created.videoIds.push(clipTestVideo.rows[0].id);

    const outsiderView = await req(`/api/videos/${teamVideo.rows[0].id}`, { token: outsider.token });
    // 5. Unrelated user blocked from private team film.
    assert("unrelated user blocked from viewing team-scoped video", outsiderView.status === 403);

    const memberView = await req(`/api/videos/${teamVideo.rows[0].id}`, { token: athlete1.token });
    // 6. Authorized team member CAN view permitted film.
    assert("authorized team member can view team-scoped video", memberView.status === 200);

    const outsiderDelete = await req(`/api/videos/${teamVideo.rows[0].id}`, {
      method: "DELETE",
      token: outsider.token,
    });
    // 7. Unrelated user blocked from deleting another's video.
    assert("unrelated user blocked from deleting another's video", outsiderDelete.status === 403);

    const coachDelete = await req(`/api/videos/${teamVideo.rows[0].id}`, {
      method: "DELETE",
      token: coach.token,
    });
    // 8. Permitted coach/uploader CAN delete per policy.
    assert("uploader/coach can delete per policy", coachDelete.status === 200);
    if (coachDelete.status === 200) created.videoIds = created.videoIds.filter((id) => id !== teamVideo.rows[0].id);

    const auditedDelete = await client.query(
      "SELECT * FROM security_audit_log WHERE event_type = 'video_deleted' AND user_id = $1 ORDER BY id DESC LIMIT 1",
      [coach.user.id]
    );
    assert("video deletion is audit-logged", auditedDelete.rows.length === 1);

    // 3. Forged user_id in a request body cannot impersonate.
    const forgedClip = await req("/api/clips", {
      method: "POST",
      token: athlete1.token,
      body: {
        title: `${RUN_TAG}_clip`,
        start_time: 0,
        end_time: 1,
        video_id: clipTestVideo.rows[0].id,
        user_id: coach.user.id, // forged — should be ignored
      },
    });
    assert(
      "forged user_id in clip body cannot impersonate",
      forgedClip.status === 201 && Number(forgedClip.data.user_id) === Number(athlete1.user.id)
    );
    if (forgedClip.status === 201) created.clipIds.push(forgedClip.data.id);

    // ---- Profile ownership ----
    const crossEdit = await req(`/api/users/${athlete1.user.id}/profile`, {
      method: "PUT",
      token: athlete2.token,
      body: { display_name: "Hijacked" },
    });
    // 9. User blocked from editing another's profile.
    assert("user blocked from editing another user's profile", crossEdit.status === 403);

    const ownEdit = await req(`/api/users/${athlete1.user.id}/profile`, {
      method: "PUT",
      token: athlete1.token,
      body: { display_name: `${RUN_TAG}_athlete1` },
    });
    assert("user can edit their own profile", ownEdit.status === 200);

    // ---- Conversations ----
    // Registration auto-joins every new user to the same default
    // conversation (pre-conversation-model behavior, see auth.js) — remove
    // outsider from it deliberately to get a genuine non-participant.
    const convo = await req("/api/conversations", { token: coach.token });
    const conversationId = convo.data?.[0]?.id;

    await client.query(
      "DELETE FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2",
      [conversationId, outsider.user.id]
    );

    const nonParticipantRead = await req(`/api/conversations/${conversationId}/messages`, {
      token: outsider.token,
    });
    // 10. Non-participant blocked from conversation read.
    assert("non-participant blocked from reading a conversation", nonParticipantRead.status === 403);

    const nonParticipantPost = await req(`/api/conversations/${conversationId}/messages`, {
      method: "POST",
      token: outsider.token,
      body: { body: "should not be allowed" },
    });
    // 10. Non-participant blocked from conversation post.
    assert("non-participant blocked from posting to a conversation", nonParticipantPost.status === 403);

    const nonParticipantReadMark = await req(`/api/conversations/${conversationId}/read`, {
      method: "PUT",
      token: outsider.token,
    });
    assert("non-participant blocked from marking a conversation read", nonParticipantReadMark.status === 403);

    const forgedMessage = await req(`/api/conversations/${conversationId}/messages`, {
      method: "POST",
      token: athlete1.token,
      body: { body: "hello from athlete1", sender_id: coach.user.id }, // forged — should be ignored
    });
    // 11. Message sender identity cannot be forged.
    assert(
      "forged sender_id in message body cannot impersonate",
      forgedMessage.status === 201 && Number(forgedMessage.data.sender_id) === Number(athlete1.user.id)
    );
    if (forgedMessage.status === 201) created.messageIds.push(forgedMessage.data.id);

    // ---- Manual + recording-pipeline upload paths accept bearer auth ----
    // A minimal but valid-enough MP4 payload — the goal here is proving the
    // route accepts the request past auth/MIME checks, not exercising real
    // video processing. Runs against local disk storage (STORAGE_PROVIDER
    // isn't "r2" in this dev environment), so it's safe to actually upload.
    const fakeVideoBytes = Buffer.from("test-video-not-real-mp4-bytes");
    const uploadForm = new FormData();
    uploadForm.append("video", new Blob([fakeVideoBytes], { type: "video/mp4" }), "test.mp4");
    uploadForm.append("title", `${RUN_TAG}_manual_upload`);

    const manualUpload = await req("/api/upload-video", {
      method: "POST",
      token: coach.token,
      body: uploadForm,
      isForm: true,
    });
    assert("manual upload succeeds with bearer auth", manualUpload.status === 201);
    if (manualUpload.status === 201) created.videoIds.push(manualUpload.data.id);

    const uploadNoAuth = await req("/api/upload-video", {
      method: "POST",
      body: uploadForm,
      isForm: true,
    });
    assert("upload without a token is rejected", uploadNoAuth.status === 401);

    console.log(
      "NOTE: signed R2 playback and the Recording Pipeline's own XHR flow are not exercised by this " +
        "script (no browser, and STORAGE_PROVIDER isn't 'r2' in this environment) — carried over as a " +
        "manual verification item once Cloudflare setup is complete, per the sprint plan."
    );

    // ---- Rate limiting ----
    let lastLoginAttempt;
    for (let i = 0; i < 11; i++) {
      lastLoginAttempt = await req("/api/auth/login", {
        method: "POST",
        body: { email: `${RUN_TAG}_rate_limit_probe@test.cresamor.local`, password: "wrong" },
      });
    }
    assert("login rate limiting triggers after repeated attempts", lastLoginAttempt.status === 429);

    const rateLimitAudit = await client.query(
      "SELECT * FROM security_audit_log WHERE event_type = 'login_rate_limited' ORDER BY id DESC LIMIT 1"
    );
    assert("rate-limit hit is audit-logged", rateLimitAudit.rows.length === 1);

    // ---- Static sweep: no route still reads a client-supplied identity field ----
    const fs = require("fs");
    const path = require("path");
    const routesDir = path.join(__dirname, "../routes");
    const dangerousPatterns = [
      /req\.body\.(?:requesting_)?user_id/,
      /req\.body\.uploaded_by/,
      /req\.body\.sender_id/,
      /req\.query\.user_id/,
    ];
    const offenders = [];
    for (const file of fs.readdirSync(routesDir)) {
      const src = fs.readFileSync(path.join(routesDir, file), "utf8");
      for (const pattern of dangerousPatterns) {
        if (pattern.test(src)) offenders.push(`${file}: ${pattern}`);
      }
    }
    assert("no route reads a client-supplied identity field", offenders.length === 0, offenders.join("; "));
  } finally {
    // ---- Cleanup: delete every row this script created, best-effort. ----
    try {
      for (const id of created.messageIds) {
        await client.query("DELETE FROM messages WHERE id = $1", [id]);
      }
      for (const id of created.clipIds) {
        await client.query("DELETE FROM clips WHERE id = $1", [id]);
      }
      for (const id of created.videoIds) {
        const videoRow = await client.query("SELECT storage_key FROM videos WHERE id = $1", [id]);
        const storageKey = videoRow.rows[0]?.storage_key;
        if (storageKey) await storage.remove(storageKey);

        await client.query("DELETE FROM clips WHERE video_id = $1", [id]);
        await client.query("DELETE FROM videos WHERE id = $1", [id]);
      }
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
        await client.query("DELETE FROM conversation_participants WHERE user_id = $1", [id]);
        await client.query("DELETE FROM security_audit_log WHERE user_id = $1", [id]);
        await client.query("DELETE FROM messages WHERE sender_id = $1", [id]);
        await client.query("DELETE FROM clips WHERE user_id = $1", [id]);
        await client.query("DELETE FROM team_members WHERE user_id = $1", [id]);
        await client.query("DELETE FROM videos WHERE uploaded_by = $1", [id]);
        await client.query("DELETE FROM users WHERE id = $1", [id]);
      }
      await client.query(
        "DELETE FROM security_audit_log WHERE metadata->>'email' LIKE $1",
        [`${RUN_TAG}%`]
      );
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
