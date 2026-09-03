/*
  testTeamHighlightsRoutes.js — Team Highlights, Slice 2 acceptance suite.
  GET/POST/DELETE for /api/teams/:teamId/highlights. Same conventions as
  every other production-backed test script in this project: real app on
  a throwaway local port, real HTTP calls, RUN_TAG-namespaced fixtures,
  complete fixture tracking (every id this run creates, not a selective
  subset), full cleanup in a finally block regardless of pass/fail.

  Run by hand:
    ALLOW_PRODUCTION_TESTS=true STORAGE_PROVIDER=r2 node server/scripts/testTeamHighlightsRoutes.js

  Requires migrations through 019 already applied — this script only
  exercises routes, it never touches schema (Slice 2 needed none).
*/

require("dotenv").config();

const { requireProductionTestOptIn } = require("./lib/requireProductionTestOptIn");
requireProductionTestOptIn("testTeamHighlightsRoutes.js");

if (process.env.STORAGE_PROVIDER !== "r2" && process.env.STORAGE_PROVIDER !== "local") {
  console.error("STORAGE_PROVIDER must be 'r2' or 'local' -- run with one of those.");
  process.exit(1);
}

const app = require("../app");
const client = require("../db/client");
const storage = require("../services/storage/storage");
const sourceRetention = require("../services/sourceRetention");
const auditLog = require("../services/auditLog");

const PORT = 3994;
const BASE_URL = `http://localhost:${PORT}`;
const RUN_TAG = `throutes_${Date.now()}`;

const results = [];
function assert(name, condition, detail) {
  results.push({ name, pass: Boolean(condition) });
  console.log(`${condition ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
}

async function req(path, { method = "GET", token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  // Correction (found by actually running this suite): the unauthenticated
  // GET test deliberately triggers authenticate.js's real auth_rejected
  // audit event, which has NULL user_id and leaked past cleanup on the
  // first real run. Same exact-ID correlation mechanism already
  // established for testAuth.js/testInvitations.js -- tags the resulting
  // audit row's metadata so cleanup can find and delete exactly it.
  headers["X-Test-Correlation-Id"] = RUN_TAG;
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
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
  const { status, data } = await req("/api/auth/register", { method: "POST", body: { email, password: "TestPass123!", role } });
  if (status !== 201) throw new Error(`register ${email} (${role}) failed: ${status} ${JSON.stringify(data)}`);
  return data;
}

// Direct insert -- matches testTeamHighlightsRetention.js's own
// insertBareVideo convention. Never a real R2 object unless a caller
// explicitly uploads one afterward (see the lifecycle section).
async function insertVideo({
  uploadedBy,
  teamId = null,
  uploadDestination = "personal",
  filmRemovedAt = null,
  storageKey = null,
  title,
}) {
  const key = storageKey || `videos/test/${RUN_TAG}/${Math.random().toString(36).slice(2)}.mp4`;
  const result = await client.query(
    `
    INSERT INTO videos (title, storage_key, uploaded_by, processing_status, team_id, source_size_bytes, upload_destination, film_removed_at)
    VALUES ($1, $2, $3, 'ready', $4, 100, $5, $6)
    RETURNING *
    `,
    [title || `${RUN_TAG}_video`, key, uploadedBy, teamId, uploadDestination, filmRemovedAt]
  );
  return result.rows[0];
}

async function main() {
  const created = {
    userIds: [],
    teamIds: [],
    videoIds: [],
    allFixtureVideoIds: [],
    highlightIds: [],
    r2Keys: [],
  };
  function trackVideo(id) {
    created.videoIds.push(id);
    created.allFixtureVideoIds.push(id);
  }
  function trackHighlight(id) {
    if (id !== null && id !== undefined) created.highlightIds.push(id);
  }

  const server = app.listen(PORT);

  try {
    // ---- Fixtures: exactly 5 registrations (registerLimiter cap) ----
    const coach = await registerUser(`${RUN_TAG}-coach@test.cresamor.local`, "coach");
    const assistantCoach = await registerUser(`${RUN_TAG}-assistant-coach@test.cresamor.local`, "assistant_coach");
    const athlete = await registerUser(`${RUN_TAG}-athlete@test.cresamor.local`, "athlete");
    const parent = await registerUser(`${RUN_TAG}-parent@test.cresamor.local`, "parent");
    const outsiderCoach = await registerUser(`${RUN_TAG}-outsider-coach@test.cresamor.local`, "coach");
    created.userIds.push(coach.user.id, assistantCoach.user.id, athlete.user.id, parent.user.id, outsiderCoach.user.id);

    const teamACreate = await req("/api/teams", { method: "POST", token: coach.token, body: { name: `${RUN_TAG} Team A` } });
    const teamA = teamACreate.data;
    created.teamIds.push(teamA.id);

    const teamBCreate = await req("/api/teams", { method: "POST", token: outsiderCoach.token, body: { name: `${RUN_TAG} Team B` } });
    const teamB = teamBCreate.data;
    created.teamIds.push(teamB.id);

    await client.query("INSERT INTO team_members (team_id, user_id, role_on_team) VALUES ($1,$2,'assistant_coach')", [teamA.id, assistantCoach.user.id]);
    await client.query("INSERT INTO team_members (team_id, user_id, role_on_team) VALUES ($1,$2,'athlete')", [teamA.id, athlete.user.id]);
    await client.query("INSERT INTO team_members (team_id, user_id, role_on_team) VALUES ($1,$2,'parent')", [teamA.id, parent.user.id]);

    // ============================================================
    // GET /api/teams/:teamId/highlights
    // ============================================================
    const emptyFeed = await req(`/api/teams/${teamA.id}/highlights`, { token: coach.token });
    assert("GET: empty feed responds 200 with []", emptyFeed.status === 200 && Array.isArray(emptyFeed.data) && emptyFeed.data.length === 0);

    const unauthedFeed = await req(`/api/teams/${teamA.id}/highlights`);
    assert("GET: unauthenticated -> 401", unauthedFeed.status === 401);

    const outsiderFeed = await req(`/api/teams/${teamA.id}/highlights`, { token: outsiderCoach.token });
    assert("GET: unrelated coach (no membership on team A) -> 403", outsiderFeed.status === 403);

    // Revoke athlete, confirm 403, then restore for later tests.
    await client.query("UPDATE team_members SET revoked_at = now() WHERE team_id = $1 AND user_id = $2", [teamA.id, athlete.user.id]);
    const revokedFeed = await req(`/api/teams/${teamA.id}/highlights`, { token: athlete.token });
    assert("GET: revoked member -> 403", revokedFeed.status === 403);
    await client.query("UPDATE team_members SET revoked_at = NULL WHERE team_id = $1 AND user_id = $2", [teamA.id, athlete.user.id]);

    for (const [label, user] of [["coach", coach], ["assistant_coach", assistantCoach], ["athlete", athlete], ["parent", parent]]) {
      const result = await req(`/api/teams/${teamA.id}/highlights`, { token: user.token });
      assert(`GET: active ${label} -> 200`, result.status === 200);
    }

    // ============================================================
    // Source eligibility -- generic 404, indistinguishable
    // ============================================================
    const personalSource = await insertVideo({ uploadedBy: coach.user.id, title: `${RUN_TAG}_personal` });
    trackVideo(personalSource.id);

    const crossTeamSource = await insertVideo({ uploadedBy: outsiderCoach.user.id, teamId: teamB.id, uploadDestination: "team_film", title: `${RUN_TAG}_crossteam` });
    trackVideo(crossTeamSource.id);

    const filmRemovedSource = await insertVideo({
      uploadedBy: coach.user.id, teamId: teamA.id, uploadDestination: "team_film", filmRemovedAt: new Date(), title: `${RUN_TAG}_filmremoved`,
    });
    trackVideo(filmRemovedSource.id);

    const missingVideoId = 999999999;

    const ineligibleCases = [
      ["nonexistent video_id", missingVideoId],
      ["Personal Film source", personalSource.id],
      ["another team's source", crossTeamSource.id],
      ["Film-removed source", filmRemovedSource.id],
    ];
    for (const [label, videoId] of ineligibleCases) {
      const result = await req(`/api/teams/${teamA.id}/highlights`, { method: "POST", token: coach.token, body: { video_id: videoId } });
      assert(`POST: ${label} -> generic 404`, result.status === 404, `status=${result.status}`);
    }
    const countAfterIneligible = await client.query("SELECT count(*)::int AS c FROM team_highlights WHERE team_id = $1", [teamA.id]);
    assert("POST: none of the ineligible attempts created any row", countAfterIneligible.rows[0].c === 0);

    // ============================================================
    // POST authorization
    // ============================================================
    const eligibleSource = await insertVideo({ uploadedBy: athlete.user.id, teamId: teamA.id, uploadDestination: "team_film", title: `${RUN_TAG}_eligible1` });
    trackVideo(eligibleSource.id);

    for (const [label, user] of [["athlete", athlete], ["parent", parent], ["outsider coach", outsiderCoach]]) {
      const result = await req(`/api/teams/${teamA.id}/highlights`, { method: "POST", token: user.token, body: { video_id: eligibleSource.id } });
      assert(`POST: ${label} cannot publish -> 403`, result.status === 403, `status=${result.status}`);
    }

    await client.query("UPDATE team_members SET revoked_at = now() WHERE team_id = $1 AND user_id = $2", [teamA.id, athlete.user.id]);
    const revokedPublish = await req(`/api/teams/${teamA.id}/highlights`, { method: "POST", token: athlete.token, body: { video_id: eligibleSource.id } });
    assert("POST: revoked member cannot publish -> 403", revokedPublish.status === 403);
    await client.query("UPDATE team_members SET revoked_at = NULL WHERE team_id = $1 AND user_id = $2", [teamA.id, athlete.user.id]);

    // Forged body team_id -- URL must win, never the body.
    const forgedTeamPublish = await req(`/api/teams/${teamA.id}/highlights`, {
      method: "POST", token: coach.token, body: { video_id: eligibleSource.id, team_id: teamB.id },
    });
    assert("POST: succeeds despite a forged body team_id", forgedTeamPublish.status === 201, `status=${forgedTeamPublish.status}`);
    assert("POST: the created post belongs to the URL team, not the body team", forgedTeamPublish.data.team_id === teamA.id);
    trackHighlight(forgedTeamPublish.data.id);
    // Clean this one up before the idempotency tests below reuse eligibleSource.
    await client.query("DELETE FROM team_highlights WHERE id = $1", [forgedTeamPublish.data.id]);
    created.highlightIds = created.highlightIds.filter((id) => id !== forgedTeamPublish.data.id);

    // ============================================================
    // POST: fresh publish, response shape, idempotent replay, republish
    // ============================================================
    const freshPublish = await req(`/api/teams/${teamA.id}/highlights`, { method: "POST", token: coach.token, body: { video_id: eligibleSource.id } });
    assert("POST: coach publishes eligible source -> 201", freshPublish.status === 201, `status=${freshPublish.status}`);
    trackHighlight(freshPublish.data.id);

    const responseKeys = Object.keys(freshPublish.data).sort();
    assert(
      "POST: response has exactly the expected top-level keys",
      JSON.stringify(responseKeys) === JSON.stringify(["created_at", "created_by", "id", "removed_at", "team_id", "video", "video_id"].sort())
    );
    const videoKeys = Object.keys(freshPublish.data.video).sort();
    assert(
      "POST: embedded video has exactly the safe allowlisted fields",
      JSON.stringify(videoKeys) ===
        JSON.stringify(["available", "created_at", "film_type", "id", "playback_state", "team_id", "thumbnail_url", "title", "uploaded_by", "file_url"].sort())
    );
    assert("POST: embedded video never leaks storage_key", !("storage_key" in freshPublish.data.video));
    assert("POST: embedded video never leaks upload_destination", !("upload_destination" in freshPublish.data.video));
    assert("POST: embedded video never leaks purge_status", !("purge_status" in freshPublish.data.video));

    const idempotentReplay = await req(`/api/teams/${teamA.id}/highlights`, { method: "POST", token: assistantCoach.token, body: { video_id: eligibleSource.id } });
    assert("POST: idempotent replay by a DIFFERENT authorized staff member -> 200", idempotentReplay.status === 200, `status=${idempotentReplay.status}`);
    assert("POST: idempotent replay returns the SAME post id", idempotentReplay.data.id === freshPublish.data.id);

    const activeCountAfterReplay = await client.query(
      "SELECT count(*)::int AS c FROM team_highlights WHERE team_id = $1 AND video_id = $2 AND removed_at IS NULL",
      [teamA.id, eligibleSource.id]
    );
    assert("POST: exactly one active row exists despite the replay", activeCountAfterReplay.rows[0].c === 1);

    // Concurrent double-publish, real parallel requests.
    const raceSource = await insertVideo({ uploadedBy: coach.user.id, teamId: teamA.id, uploadDestination: "team_film", title: `${RUN_TAG}_race` });
    trackVideo(raceSource.id);
    const [raceA, raceB] = await Promise.all([
      req(`/api/teams/${teamA.id}/highlights`, { method: "POST", token: coach.token, body: { video_id: raceSource.id } }),
      req(`/api/teams/${teamA.id}/highlights`, { method: "POST", token: coach.token, body: { video_id: raceSource.id } }),
    ]);
    const raceStatuses = [raceA.status, raceB.status].sort();
    assert("POST: concurrent duplicate publish -> one 201 and one 200", JSON.stringify(raceStatuses) === JSON.stringify([200, 201]), `statuses=${raceStatuses}`);
    assert("POST: concurrent duplicate publish returns the SAME post id both times", raceA.data.id === raceB.data.id);
    trackHighlight(raceA.data.id);
    const raceRowCount = await client.query("SELECT count(*)::int AS c FROM team_highlights WHERE team_id = $1 AND video_id = $2", [teamA.id, raceSource.id]);
    assert("POST: concurrent duplicate publish created exactly one row total", raceRowCount.rows[0].c === 1);

    // ============================================================
    // POST: purge_pending source -> 409 (only after eligibility passes)
    // ============================================================
    const pendingSource = await insertVideo({ uploadedBy: coach.user.id, teamId: teamA.id, uploadDestination: "team_film", title: `${RUN_TAG}_pending` });
    trackVideo(pendingSource.id);
    await client.query("UPDATE videos SET purge_status = 'purge_pending' WHERE id = $1", [pendingSource.id]);
    const pendingPublish = await req(`/api/teams/${teamA.id}/highlights`, { method: "POST", token: coach.token, body: { video_id: pendingSource.id } });
    assert("POST: otherwise-eligible but purge_pending source -> 409", pendingPublish.status === 409, `status=${pendingPublish.status}`);
    await client.query("UPDATE videos SET purge_status = 'active' WHERE id = $1", [pendingSource.id]);

    // ============================================================
    // Republish after removal -> new row, old row survives as history
    // ============================================================
    const republishSource = await insertVideo({ uploadedBy: coach.user.id, teamId: teamA.id, uploadDestination: "team_film", title: `${RUN_TAG}_republish` });
    trackVideo(republishSource.id);
    const firstPublish = await req(`/api/teams/${teamA.id}/highlights`, { method: "POST", token: coach.token, body: { video_id: republishSource.id } });
    trackHighlight(firstPublish.data.id);
    const firstRemove = await req(`/api/teams/${teamA.id}/highlights/${firstPublish.data.id}`, { method: "DELETE", token: coach.token });
    assert("republish setup: first post removed", firstRemove.status === 200);
    const secondPublish = await req(`/api/teams/${teamA.id}/highlights`, { method: "POST", token: coach.token, body: { video_id: republishSource.id } });
    assert("POST: republish after removal succeeds -> 201, NEW id", secondPublish.status === 201 && secondPublish.data.id !== firstPublish.data.id);
    trackHighlight(secondPublish.data.id);
    const oldRowSurvives = await client.query("SELECT removed_at FROM team_highlights WHERE id = $1", [firstPublish.data.id]);
    assert("republish: the old removed row survives untouched", oldRowSurvives.rows.length === 1 && oldRowSurvives.rows[0].removed_at !== null);

    // ============================================================
    // Processing-state behavior: publish is allowed regardless of
    // processing_status; the feed surfaces the real calculated state.
    // ============================================================
    const processingSource = await insertVideo({ uploadedBy: coach.user.id, teamId: teamA.id, uploadDestination: "team_film", title: `${RUN_TAG}_processing` });
    trackVideo(processingSource.id);
    await client.query("UPDATE videos SET processing_status = 'classifying' WHERE id = $1", [processingSource.id]);
    const processingPublish = await req(`/api/teams/${teamA.id}/highlights`, { method: "POST", token: coach.token, body: { video_id: processingSource.id } });
    assert("POST: a still-processing source can be published", processingPublish.status === 201, `status=${processingPublish.status}`);
    trackHighlight(processingPublish.data.id);
    assert("POST: response reflects the real processing playback_state", processingPublish.data.video.playback_state === "preparing_playback");

    const failedSource = await insertVideo({ uploadedBy: coach.user.id, teamId: teamA.id, uploadDestination: "team_film", title: `${RUN_TAG}_failed` });
    trackVideo(failedSource.id);
    await client.query("UPDATE videos SET processing_status = 'failed' WHERE id = $1", [failedSource.id]);
    const failedPublish = await req(`/api/teams/${teamA.id}/highlights`, { method: "POST", token: coach.token, body: { video_id: failedSource.id } });
    assert("POST: a terminal-failure source can be published", failedPublish.status === 201);
    trackHighlight(failedPublish.data.id);
    assert("POST: response reflects the real failed playback_state", failedPublish.data.video.playback_state === "failed");

    const feedWithProcessingState = await req(`/api/teams/${teamA.id}/highlights`, { token: coach.token });
    const processingEntry = feedWithProcessingState.data.find((h) => h.id === processingPublish.data.id);
    assert("GET: feed surfaces the processing source's real playback_state", processingEntry && processingEntry.video.playback_state === "preparing_playback");

    // ============================================================
    // DELETE authorization
    // ============================================================
    // Original, non-staff uploader removes their own post -- eligibleSource
    // was uploaded by athlete; freshPublish is still the active post on it.
    const nonUploaderNonStaffRemove = await req(`/api/teams/${teamA.id}/highlights/${freshPublish.data.id}`, { method: "DELETE", token: parent.token });
    assert("DELETE: non-uploader, non-staff (parent) -> 403", nonUploaderNonStaffRemove.status === 403);

    const uploaderRemove = await req(`/api/teams/${teamA.id}/highlights/${freshPublish.data.id}`, { method: "DELETE", token: athlete.token });
    assert("DELETE: original (non-staff) uploader removes their own post -> 200", uploaderRemove.status === 200, `status=${uploaderRemove.status}`);

    // Lifecycle case 1 (correction): eligibleSource was NEVER film-removed.
    // Removing its only reference must leave the source completely alone.
    const sourceAfterUploaderRemove = await client.query(
      "SELECT purge_status, purge_reevaluation_requested_at FROM videos WHERE id = $1",
      [eligibleSource.id]
    );
    assert(
      "LIFECYCLE 1: removing the only post on a Film-visible source does NOT mark it for reevaluation",
      sourceAfterUploaderRemove.rows.length === 1 && sourceAfterUploaderRemove.rows[0].purge_reevaluation_requested_at === null
    );
    await sourceRetention.sweepPurgeReevaluations();
    const sourceStillExistsAfterSweep = await client.query("SELECT id FROM videos WHERE id = $1", [eligibleSource.id]);
    assert("LIFECYCLE 1: the source video row still exists after a sweep pass", sourceStillExistsAfterSweep.rows.length === 1);

    // Staff removes a post regardless of who published or uploaded it.
    const staffRemoveVideo = await insertVideo({ uploadedBy: parent.user.id, teamId: teamA.id, uploadDestination: "team_film", title: `${RUN_TAG}_staffremove` });
    trackVideo(staffRemoveVideo.id);
    const staffRemovePublish = await req(`/api/teams/${teamA.id}/highlights`, { method: "POST", token: assistantCoach.token, body: { video_id: staffRemoveVideo.id } });
    trackHighlight(staffRemovePublish.data.id);
    const staffRemoveResult = await req(`/api/teams/${teamA.id}/highlights/${staffRemovePublish.data.id}`, { method: "DELETE", token: coach.token });
    assert("DELETE: staff removes a post they didn't publish, on a source they didn't upload -> 200", staffRemoveResult.status === 200);

    // Cross-team id/URL mismatch -> 404, never a leak.
    const crossTeamPostVideo = await insertVideo({ uploadedBy: outsiderCoach.user.id, teamId: teamB.id, uploadDestination: "team_film", title: `${RUN_TAG}_teamBpost` });
    trackVideo(crossTeamPostVideo.id);
    const crossTeamPostPublish = await req(`/api/teams/${teamB.id}/highlights`, { method: "POST", token: outsiderCoach.token, body: { video_id: crossTeamPostVideo.id } });
    trackHighlight(crossTeamPostPublish.data.id);
    const crossTeamDelete = await req(`/api/teams/${teamA.id}/highlights/${crossTeamPostPublish.data.id}`, { method: "DELETE", token: coach.token });
    assert("DELETE: a real highlight id from another team, via this team's URL -> 404", crossTeamDelete.status === 404, `status=${crossTeamDelete.status}`);
    // Confirm it's untouched.
    const crossTeamStillActive = await client.query("SELECT removed_at FROM team_highlights WHERE id = $1", [crossTeamPostPublish.data.id]);
    assert("DELETE: the cross-team post was never actually touched", crossTeamStillActive.rows[0].removed_at === null);

    // Idempotent no-op (video_id still present).
    const idemRemoveVideo = await insertVideo({ uploadedBy: coach.user.id, teamId: teamA.id, uploadDestination: "team_film", title: `${RUN_TAG}_idemremove` });
    trackVideo(idemRemoveVideo.id);
    const idemRemovePublish = await req(`/api/teams/${teamA.id}/highlights`, { method: "POST", token: coach.token, body: { video_id: idemRemoveVideo.id } });
    trackHighlight(idemRemovePublish.data.id);
    const idemRemove1 = await req(`/api/teams/${teamA.id}/highlights/${idemRemovePublish.data.id}`, { method: "DELETE", token: coach.token });
    assert("DELETE: first removal -> 200", idemRemove1.status === 200);
    const idemRemove2 = await req(`/api/teams/${teamA.id}/highlights/${idemRemovePublish.data.id}`, { method: "DELETE", token: coach.token });
    assert("DELETE: repeated removal -> 200 idempotent no-op", idemRemove2.status === 200);
    assert("DELETE: removed_at is identical between the two calls (no re-mutation)", idemRemove1.data.removed_at === idemRemove2.data.removed_at);
    const idemRemovedAuditCount = await client.query(
      `SELECT count(*)::int AS c FROM security_audit_log WHERE event_type = 'team_highlight_removed' AND (metadata->>'teamHighlightId')::int = $1`,
      [idemRemovePublish.data.id]
    );
    assert("DELETE: exactly one removal audit row exists despite the repeat", idemRemovedAuditCount.rows[0].c === 1);

    // Concurrent double-DELETE.
    const concurrentRemoveVideo = await insertVideo({ uploadedBy: coach.user.id, teamId: teamA.id, uploadDestination: "team_film", title: `${RUN_TAG}_concurrentremove` });
    trackVideo(concurrentRemoveVideo.id);
    const concurrentRemovePublish = await req(`/api/teams/${teamA.id}/highlights`, { method: "POST", token: coach.token, body: { video_id: concurrentRemoveVideo.id } });
    trackHighlight(concurrentRemovePublish.data.id);
    const [concA, concB] = await Promise.all([
      req(`/api/teams/${teamA.id}/highlights/${concurrentRemovePublish.data.id}`, { method: "DELETE", token: coach.token }),
      req(`/api/teams/${teamA.id}/highlights/${concurrentRemovePublish.data.id}`, { method: "DELETE", token: coach.token }),
    ]);
    assert("DELETE: concurrent double-remove both return 200", concA.status === 200 && concB.status === 200);
    assert("DELETE: concurrent double-remove agree on the same removed_at", concA.data.removed_at === concB.data.removed_at);
    const concurrentAuditCount = await client.query(
      `SELECT count(*)::int AS c FROM security_audit_log WHERE event_type = 'team_highlight_removed' AND (metadata->>'teamHighlightId')::int = $1`,
      [concurrentRemovePublish.data.id]
    );
    assert("DELETE: concurrent double-remove produced exactly ONE audit row, not two", concurrentAuditCount.rows[0].c === 1);

    // ============================================================
    // LIFECYCLE 2: film-removed source, post is the ONLY reference ->
    // removal marks for reevaluation -> sweeper physically purges the
    // DB row AND the real storage object.
    // ============================================================
    const lifecycle2Key = `videos/test/${RUN_TAG}/lifecycle2.mp4`;
    const tmpPath1 = require("path").join(require("os").tmpdir(), `${RUN_TAG}-lifecycle2.mp4`);
    require("fs").writeFileSync(tmpPath1, Buffer.from("lifecycle 2 test bytes"));
    await storage.upload(lifecycle2Key, tmpPath1, "video/mp4", { category: "video" });
    created.r2Keys.push(lifecycle2Key);

    const lifecycle2Video = await insertVideo({
      uploadedBy: coach.user.id, teamId: teamA.id, uploadDestination: "team_film", storageKey: lifecycle2Key, title: `${RUN_TAG}_lifecycle2`,
    });
    trackVideo(lifecycle2Video.id);
    const lifecycle2Publish = await req(`/api/teams/${teamA.id}/highlights`, { method: "POST", token: coach.token, body: { video_id: lifecycle2Video.id } });
    assert("LIFECYCLE 2 setup: publish succeeds (still Film-visible)", lifecycle2Publish.status === 201);
    trackHighlight(lifecycle2Publish.data.id);

    // Film-remove the source AFTER publishing (must not touch the post).
    const lifecycle2FilmRemove = await req(`/api/videos/${lifecycle2Video.id}/film-removal`, { method: "PATCH", token: coach.token });
    assert("LIFECYCLE 2 setup: source film-removed while post still active", lifecycle2FilmRemove.status === 200);
    const lifecycle2PostStillActive = await client.query("SELECT removed_at FROM team_highlights WHERE id = $1", [lifecycle2Publish.data.id]);
    assert("LIFECYCLE 2: film-removing the source does not touch its active post", lifecycle2PostStillActive.rows[0].removed_at === null);
    await sourceRetention.sweepPurgeReevaluations();
    const lifecycle2StillExists = await client.query("SELECT id FROM videos WHERE id = $1", [lifecycle2Video.id]);
    assert("LIFECYCLE 2: source survives a sweep pass while its post is still active", lifecycle2StillExists.rows.length === 1);

    const lifecycle2Remove = await req(`/api/teams/${teamA.id}/highlights/${lifecycle2Publish.data.id}`, { method: "DELETE", token: coach.token });
    assert("LIFECYCLE 2: removing the post (source already Film-removed) -> 200", lifecycle2Remove.status === 200);
    const lifecycle2MarkedForReevaluation = await client.query("SELECT purge_reevaluation_requested_at FROM videos WHERE id = $1", [lifecycle2Video.id]);
    assert(
      "LIFECYCLE 2: removal DOES mark the now-Film-removed source for reevaluation",
      lifecycle2MarkedForReevaluation.rows.length === 1 && lifecycle2MarkedForReevaluation.rows[0].purge_reevaluation_requested_at !== null
    );

    await sourceRetention.sweepPurgeReevaluations();
    const lifecycle2Gone = await client.query("SELECT id FROM videos WHERE id = $1", [lifecycle2Video.id]);
    assert("LIFECYCLE 2: the source's database row is gone after the sweep", lifecycle2Gone.rows.length === 0);
    const lifecycle2ObjectGone = await storage.exists(lifecycle2Key);
    assert("LIFECYCLE 2: the real storage object is gone after the sweep", lifecycle2ObjectGone === false);
    created.videoIds = created.videoIds.filter((id) => id !== lifecycle2Video.id);
    created.r2Keys = created.r2Keys.filter((k) => k !== lifecycle2Key);

    // ============================================================
    // LIFECYCLE 3: film-removed source with BOTH a clip and the post ->
    // removing the post alone still leaves the source retained (clip).
    // ============================================================
    const lifecycle3Video = await insertVideo({ uploadedBy: coach.user.id, teamId: teamA.id, uploadDestination: "team_film", title: `${RUN_TAG}_lifecycle3` });
    trackVideo(lifecycle3Video.id);
    const lifecycle3Publish = await req(`/api/teams/${teamA.id}/highlights`, { method: "POST", token: coach.token, body: { video_id: lifecycle3Video.id } });
    trackHighlight(lifecycle3Publish.data.id);
    const lifecycle3Clip = await req("/api/clips", { method: "POST", token: coach.token, body: { title: "lifecycle3 clip", start_time: 0, end_time: 1, video_id: lifecycle3Video.id } });
    assert("LIFECYCLE 3 setup: clip created alongside the active post", lifecycle3Clip.status === 201);
    await req(`/api/videos/${lifecycle3Video.id}/film-removal`, { method: "PATCH", token: coach.token });

    const lifecycle3Remove = await req(`/api/teams/${teamA.id}/highlights/${lifecycle3Publish.data.id}`, { method: "DELETE", token: coach.token });
    assert("LIFECYCLE 3: removing the post (source Film-removed, clip still present) -> 200", lifecycle3Remove.status === 200);
    await sourceRetention.sweepPurgeReevaluations();
    const lifecycle3Retained = await client.query("SELECT id, purge_status, purge_reevaluation_requested_at FROM videos WHERE id = $1", [lifecycle3Video.id]);
    assert(
      "LIFECYCLE 3: the source is RETAINED -- the clip alone is enough to block purge",
      lifecycle3Retained.rows.length === 1 && lifecycle3Retained.rows[0].purge_status === "active" && lifecycle3Retained.rows[0].purge_reevaluation_requested_at === null
    );

    // ============================================================
    // Purged-source DELETE fallback: once video_id is NULL, the
    // uploader carve-out is unavailable; only staff may repeat-confirm.
    // (Reuses LIFECYCLE 2's already-purged post, whose video_id is now NULL.)
    // ============================================================
    const purgedFallbackNonStaff = await req(`/api/teams/${teamA.id}/highlights/${lifecycle2Publish.data.id}`, { method: "DELETE", token: athlete.token });
    assert(
      "DELETE (post-purge fallback): a non-staff caller (even the source's own former uploader-role) -> 403",
      purgedFallbackNonStaff.status === 403,
      `status=${purgedFallbackNonStaff.status}`
    );
    const purgedFallbackStaff = await req(`/api/teams/${teamA.id}/highlights/${lifecycle2Publish.data.id}`, { method: "DELETE", token: coach.token });
    assert("DELETE (post-purge fallback): staff -> 200 idempotent no-op", purgedFallbackStaff.status === 200);
    assert("DELETE (post-purge fallback): response has no video data (video_id is NULL)", purgedFallbackStaff.data.video_id === null);

    // ============================================================
    // Audit-failure rollback: publish
    // ============================================================
    const auditFailPublishVideo = await insertVideo({ uploadedBy: coach.user.id, teamId: teamA.id, uploadDestination: "team_film", title: `${RUN_TAG}_auditfailpublish` });
    trackVideo(auditFailPublishVideo.id);
    const originalLogSecurityEvent = auditLog.logSecurityEvent;
    auditLog.logSecurityEvent = async () => {
      throw new Error("simulated audit insertion failure");
    };
    const auditFailPublish = await req(`/api/teams/${teamA.id}/highlights`, { method: "POST", token: coach.token, body: { video_id: auditFailPublishVideo.id } });
    auditLog.logSecurityEvent = originalLogSecurityEvent;
    assert("AUDIT FAILURE: publish returns 500 when the audit write fails", auditFailPublish.status === 500, `status=${auditFailPublish.status}`);
    const auditFailPublishRowCount = await client.query("SELECT count(*)::int AS c FROM team_highlights WHERE video_id = $1", [auditFailPublishVideo.id]);
    assert("AUDIT FAILURE: no team_highlights row was left committed after the rollback", auditFailPublishRowCount.rows[0].c === 0);

    // ============================================================
    // Audit-failure rollback: removal
    // ============================================================
    const auditFailRemoveVideo = await insertVideo({ uploadedBy: coach.user.id, teamId: teamA.id, uploadDestination: "team_film", title: `${RUN_TAG}_auditfailremove` });
    trackVideo(auditFailRemoveVideo.id);
    const auditFailRemovePublish = await req(`/api/teams/${teamA.id}/highlights`, { method: "POST", token: coach.token, body: { video_id: auditFailRemoveVideo.id } });
    trackHighlight(auditFailRemovePublish.data.id);

    auditLog.logSecurityEvent = async () => {
      throw new Error("simulated audit insertion failure");
    };
    const auditFailRemove = await req(`/api/teams/${teamA.id}/highlights/${auditFailRemovePublish.data.id}`, { method: "DELETE", token: coach.token });
    auditLog.logSecurityEvent = originalLogSecurityEvent;
    assert("AUDIT FAILURE: removal returns 500 when the audit write fails", auditFailRemove.status === 500, `status=${auditFailRemove.status}`);
    const auditFailRemoveRow = await client.query("SELECT removed_at FROM team_highlights WHERE id = $1", [auditFailRemovePublish.data.id]);
    assert("AUDIT FAILURE: removed_at was NOT committed after the rollback", auditFailRemoveRow.rows[0].removed_at === null);

    // ============================================================
    // Audit correctness: exactly one publish + one removal audit row
    // per REAL action across this whole run's fixtures (spot-check).
    // ============================================================
    const publishAuditCount = await client.query(
      `SELECT count(*)::int AS c FROM security_audit_log WHERE event_type = 'team_highlight_published' AND (metadata->>'teamHighlightId')::int = $1`,
      [freshPublish.data.id]
    );
    assert("AUDIT: exactly one publish audit row for the fresh publish (not the later idempotent replay)", publishAuditCount.rows[0].c === 1);

    console.log("Cleanup starting...");
  } finally {
    try {
      for (const key of created.r2Keys) {
        await storage.remove(key).catch(() => {});
      }
      for (const id of created.highlightIds) {
        await client.query("DELETE FROM team_highlights WHERE id = $1", [id]);
      }
      for (const id of created.videoIds) {
        await client.query("DELETE FROM team_highlights WHERE video_id = $1", [id]);
        await client.query("DELETE FROM clips WHERE video_id = $1", [id]);
        const videoRow = await client.query("SELECT storage_key FROM videos WHERE id = $1", [id]);
        if (videoRow.rows[0]?.storage_key) {
          await storage.remove(videoRow.rows[0].storage_key).catch(() => {});
        }
        await client.query("DELETE FROM videos WHERE id = $1", [id]);
      }
      await client.query("DELETE FROM team_highlights WHERE team_id = ANY($1::int[])", [created.teamIds]);

      for (const id of created.teamIds) {
        const convos = await client.query("SELECT id FROM conversations WHERE team_id = $1", [id]);
        for (const c of convos.rows) {
          await client.query("DELETE FROM messages WHERE conversation_id = $1", [c.id]);
          await client.query("DELETE FROM conversation_participants WHERE conversation_id = $1", [c.id]);
          await client.query("DELETE FROM conversations WHERE id = $1", [c.id]);
        }
        await client.query("DELETE FROM team_members WHERE team_id = $1", [id]);
        await client.query("DELETE FROM teams WHERE id = $1", [id]);
      }

      for (const id of created.userIds) {
        await client.query("DELETE FROM clips WHERE user_id = $1", [id]);
        await client.query("DELETE FROM team_highlights WHERE created_by = $1 OR removed_by = $1", [id]);
        await client.query("DELETE FROM upload_attempts WHERE user_id = $1", [id]);
        await client.query("DELETE FROM conversation_participants WHERE user_id = $1", [id]);
        await client.query("DELETE FROM security_audit_log WHERE user_id = $1", [id]);
        await client.query("DELETE FROM team_members WHERE user_id = $1", [id]);
        await client.query("DELETE FROM videos WHERE uploaded_by = $1", [id]);
        await client.query("DELETE FROM users WHERE id = $1", [id]);
      }

      // Complete-fixture-tracking exact-id audit cleanup (the corrected
      // Slice 1 discipline): every video and highlight id this run ever
      // created, matched against event_type + metadata.videoId or
      // metadata.teamHighlightId, deleted by exact id only.
      if (created.allFixtureVideoIds.length > 0) {
        const videoCorrelated = await client.query(
          `SELECT id FROM security_audit_log WHERE event_type = 'video_deleted' AND (metadata->>'videoId')::int = ANY($1::int[])`,
          [created.allFixtureVideoIds]
        );
        if (videoCorrelated.rows.length > 0) {
          await client.query("DELETE FROM security_audit_log WHERE id = ANY($1::int[])", [videoCorrelated.rows.map((r) => r.id)]);
        }
      }
      if (created.highlightIds.length > 0) {
        const highlightCorrelated = await client.query(
          `
          SELECT id FROM security_audit_log
          WHERE event_type IN ('team_highlight_published', 'team_highlight_removed')
            AND (metadata->>'teamHighlightId')::int = ANY($1::int[])
          `,
          [created.highlightIds]
        );
        if (highlightCorrelated.rows.length > 0) {
          await client.query("DELETE FROM security_audit_log WHERE id = ANY($1::int[])", [highlightCorrelated.rows.map((r) => r.id)]);
        }
      }
      // Exact-ID cleanup for this run's own anonymous audit rows (the
      // unauthenticated-request test), correlated by the X-Test-
      // Correlation-Id header req() sends on every call.
      const correlatedAuditRows = await client.query(
        "SELECT id FROM security_audit_log WHERE metadata->>'testCorrelationId' = $1",
        [RUN_TAG]
      );
      if (correlatedAuditRows.rows.length > 0) {
        await client.query("DELETE FROM security_audit_log WHERE id = ANY($1::int[])", [correlatedAuditRows.rows.map((r) => r.id)]);
      }

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
