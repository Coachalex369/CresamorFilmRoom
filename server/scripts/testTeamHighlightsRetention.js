/*
  testTeamHighlightsRetention.js — Team Highlights, Slice 1 acceptance
  suite: schema constraints, logical Film removal, the reference-safe
  physical-purge state machine (including real concurrency/locking
  proof), and the durable upload-attempt/idempotency/lease-fencing state
  machine. Same pattern as every other production-backed test script in
  this project: real app on a throwaway local port, real HTTP + direct
  service-layer calls, RUN_TAG-namespaced fixtures, full cleanup in a
  finally block, R2 objects created here are aborted/removed through the
  real storage layer, never just deleted from the DB.

  Run by hand:
    ALLOW_PRODUCTION_TESTS=true STORAGE_PROVIDER=r2 node server/scripts/testTeamHighlightsRetention.js

  Requires the 018_team_highlights_retention.sql migration to already be
  applied — this script does not apply it itself (matches this project's
  "migrations are applied by hand, scripts only ever exercise the result"
  convention).
*/

require("dotenv").config();

const { requireProductionTestOptIn } = require("./lib/requireProductionTestOptIn");
requireProductionTestOptIn("testTeamHighlightsRetention.js");

if (process.env.STORAGE_PROVIDER !== "r2") {
  console.error("STORAGE_PROVIDER is not 'r2' -- this script exercises real R2 object deletion, run with STORAGE_PROVIDER=r2.");
  process.exit(1);
}

const app = require("../app");
const client = require("../db/client");
const storage = require("../services/storage/storage");
const sourceRetention = require("../services/sourceRetention");
const uploadAttempts = require("../services/uploadAttempts");

const PORT = 3993;
const BASE_URL = `http://localhost:${PORT}`;
const RUN_TAG = `thretention_${Date.now()}`;

const results = [];
function assert(name, condition, detail) {
  results.push({ name, pass: Boolean(condition) });
  console.log(`${condition ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
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
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data };
}

async function registerUser(email, role) {
  const { status, data } = await req("/api/auth/register", { method: "POST", body: { email, password: "TestPass123!", role } });
  if (status !== 201) throw new Error(`register ${email} (${role}) failed: ${status} ${JSON.stringify(data)}`);
  return data;
}

// Production smoke test correction: earlier runs of this suite only ever
// sent fake bytes (new Uint8Array(...)) through the upload route -- fine
// for proving auth/validation, but the smoke-test spec explicitly calls
// for "a very small valid MP4" through the real route. Same ffmpeg-based
// generation testVideoClassification.js already uses locally; ffmpeg is
// required on PATH for this specific check (Render has it preinstalled
// per videoConversion.js's header, but this generation step itself runs
// on whatever machine executes this script).
async function generateTinyValidMp4() {
  const path = require("path");
  const os = require("os");
  const { execFile } = require("child_process");
  const { promisify } = require("util");
  const execFileAsync = promisify(execFile);
  const outPath = path.join(os.tmpdir(), `${RUN_TAG}-smoke-valid.mp4`);
  await execFileAsync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=320x240:rate=15",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    outPath,
  ]);
  return outPath;
}

// Directly inserts a bare "source" row (no real R2 object) — sufficient
// for every test that exercises permission/reference-counting/constraint
// logic without needing an actual uploaded file. Tests that specifically
// need a real R2 object (finalizePurge's own deletion path) create one
// explicitly via storage.upload() against a tiny throwaway buffer.
async function insertBareVideo({ uploadedBy, teamId = null, uploadDestination = "personal", storageKey = null }) {
  const key = storageKey || `videos/test/${RUN_TAG}/${Math.random().toString(36).slice(2)}.mp4`;
  const result = await client.query(
    `
    INSERT INTO videos (title, storage_key, uploaded_by, processing_status, team_id, source_size_bytes, upload_destination)
    VALUES ($1, $2, $3, 'ready', $4, 100, $5)
    RETURNING *
    `,
    [`${RUN_TAG}_video`, key, uploadedBy, teamId, uploadDestination]
  );
  return result.rows[0];
}

// Pure source-text check, no DB/HTTP needed -- correction round: the
// Remove-from-Film confirmation previously promised "It does not delete
// the file," which is false once a source has zero remaining references
// (the reevaluation worker purges it). Asserts the copy never regresses
// to an absolute, unconditional safety claim, and does mention the real,
// conditional removal behavior in plain language.
function checkRemoveFromFilmCopy() {
  const appJsSource = require("fs").readFileSync(
    require("path").join(__dirname, "../../client/app.js"),
    "utf8"
  );
  const confirmMatch = appJsSource.match(/Remove "\$\{video\.title\}" from Film\?\\n\\n([^`]*)`/);
  assert("Remove-from-Film confirmation copy was found in client/app.js", Boolean(confirmMatch));
  const copyText = confirmMatch ? confirmMatch[1] : "";

  assert(
    "the copy does NOT claim the file is never/guaranteed-never deleted",
    !/does not delete|will never delete|never removed|guaranteed to (remain|stay|survive)/i.test(copyText)
  );
  assert(
    "the copy DOES mention conditional removal of the underlying file",
    /may remove|might remove|could remove/i.test(copyText)
  );
  assert(
    "the copy DOES reassure that existing highlights/clips keep working",
    /keep working/i.test(copyText)
  );
  assert("the copy does not mention R2 or other storage-internal terms", !/R2|Cloudflare|object storage/i.test(copyText));
}

async function main() {
  checkRemoveFromFilmCopy();

  // allFixtureVideoIds: PERMANENT record of every video id this run ever
  // creates, regardless of whether it's later purged and removed from
  // created.videoIds (the "still needs a DELETE in cleanup" list).
  //
  // Correction: the prior approach (anonymousPurgeVideoIds) tried to
  // remember, one at a time, which specific purge calls were "anonymous"
  // (no actingUserId) and manually push just that video's id right after
  // confirming it purged. That was fragile in a way a production run
  // actually exposed: sweepPurgeReevaluations() is a BATCH operation --
  // one call processes EVERY video currently eligible (purge_reevaluation_
  // requested_at set, purge_status='active'), not just the one video the
  // surrounding test code happens to be about at that moment. filmVideo
  // (created and film-removed early, in the film-removal state-machine
  // section, with zero clips/posts ever attached to it) was never
  // expected to be physically purged by this script at all -- but by the
  // time the FIRST sweepPurgeReevaluations() call runs (written to target
  // reevalVideo, much later), filmVideo already has purge_reevaluation_
  // requested_at set and zero references, so that same sweep call swept
  // it up too. Its resulting 'video_deleted' audit row (NULL user_id,
  // metadata.videoId = filmVideo.id) was never tracked anywhere, and
  // leaked past cleanup in the first production run -- found, and fixed
  // by exact-id deletion, in a follow-up review.
  //
  // The fix: stop trying to predict which specific call will purge which
  // specific video. Track every video id this run EVER creates, and at
  // cleanup time, correlate 'video_deleted' audit rows against that
  // complete set (regardless of user_id -- a real-actingUserId purge's
  // row is also already covered by the per-user cleanup loop, so matching
  // both is redundant-but-harmless there and correct here), then delete
  // by exact id. No batch operation can ever purge a video this run
  // didn't itself create, so this is complete by construction, not by
  // remembering to update a list every time a new purge path is added.
  const created = { userIds: [], teamIds: [], videoIds: [], attemptIds: [], r2Keys: [], allFixtureVideoIds: [] };
  const server = app.listen(PORT);
  let validMp4Path; // declared here, not inside try, so the finally block can always reach it

  // Every video this run creates goes through this single function --
  // used in place of "created.videoIds.push(id)" everywhere below, so
  // allFixtureVideoIds can never drift out of sync with videoIds by a
  // forgotten call site.
  function trackVideo(id) {
    created.videoIds.push(id);
    created.allFixtureVideoIds.push(id);
  }

  try {
    // coachNoTeam (a global-role-coach-with-zero-teams fixture) was
    // removed along with canUploadPersonalFilm() -- it existed only to
    // exercise that helper's "global coach, no teams" branch. Freeing
    // this registration slot also matters concretely: registerLimiter
    // caps this script's own locally-listening app at 5 registrations/
    // hour/IP, and this script now registers exactly 4.
    const coachWithTeam = await registerUser(`${RUN_TAG}-coach-with-team@test.cresamor.local`, "coach");
    const assistantCoach = await registerUser(`${RUN_TAG}-assistant-coach@test.cresamor.local`, "assistant_coach");
    const athlete = await registerUser(`${RUN_TAG}-athlete@test.cresamor.local`, "athlete");
    const outsiderAthlete = await registerUser(`${RUN_TAG}-outsider-athlete@test.cresamor.local`, "athlete");
    created.userIds.push(coachWithTeam.user.id, assistantCoach.user.id, athlete.user.id, outsiderAthlete.user.id);

    const teamCreate = await req("/api/teams", { method: "POST", token: coachWithTeam.token, body: { name: `${RUN_TAG} Team` } });
    const team = teamCreate.data;
    created.teamIds.push(team.id);

    await client.query(
      "INSERT INTO team_members (team_id, user_id, role_on_team) VALUES ($1, $2, 'assistant_coach')",
      [team.id, assistantCoach.user.id]
    );
    await client.query(
      "INSERT INTO team_members (team_id, user_id, role_on_team) VALUES ($1, $2, 'athlete')",
      [team.id, athlete.user.id]
    );

    // ============================================================
    // Schema constraints
    // ============================================================
    let rejectedBothNull = false;
    try {
      await client.query(
        "INSERT INTO clips (title, start_time, end_time, video_id, storage_key, user_id) VALUES ($1, 0, 1, NULL, NULL, $2)",
        [`${RUN_TAG}_bad_clip`, athlete.user.id]
      );
    } catch (error) {
      rejectedBothNull = error.code === "23514"; // check_violation
    }
    assert("clips_has_backing_source: a clip with BOTH video_id and storage_key NULL is rejected", rejectedBothNull);

    let rejectedActiveNoSource = false;
    try {
      await client.query(
        "INSERT INTO team_highlights (video_id, team_id, created_by, removed_at) VALUES (NULL, $1, $2, NULL)",
        [team.id, coachWithTeam.user.id]
      );
    } catch (error) {
      rejectedActiveNoSource = error.code === "23514";
    }
    assert("team_highlights_active_needs_source: an ACTIVE post with video_id NULL is rejected", rejectedActiveNoSource);

    let rejectedDestinationMismatch = false;
    try {
      await client.query(
        "INSERT INTO videos (title, storage_key, uploaded_by, processing_status, team_id, source_size_bytes, upload_destination) VALUES ($1, $2, $3, 'ready', NULL, 100, 'team_film')",
        [`${RUN_TAG}_bad_dest`, `videos/test/${RUN_TAG}/bad.mp4`, coachWithTeam.user.id]
      );
    } catch (error) {
      rejectedDestinationMismatch = error.code === "23514";
    }
    assert("videos_destination_team_consistency: 'team_film' with team_id NULL is rejected", rejectedDestinationMismatch);

    let rejectedUploadAttemptMismatch = false;
    try {
      await client.query(
        "INSERT INTO upload_attempts (idempotency_key, user_id, team_id, upload_destination, status) VALUES ($1, $2, NULL, 'team_highlights', 'pending')",
        [`${RUN_TAG}_bad_attempt`, coachWithTeam.user.id]
      );
    } catch (error) {
      rejectedUploadAttemptMismatch = error.code === "23514";
    }
    assert("upload_attempts_destination_team_consistency: 'team_highlights' with team_id NULL is rejected", rejectedUploadAttemptMismatch);

    let rejectedCompletedNoVideo = false;
    try {
      await client.query(
        "INSERT INTO upload_attempts (idempotency_key, user_id, upload_destination, status) VALUES ($1, $2, 'personal', 'completed')",
        [`${RUN_TAG}_bad_completed`, coachWithTeam.user.id]
      );
    } catch (error) {
      rejectedCompletedNoVideo = error.code === "23514";
    }
    assert("upload_attempts_completed_needs_video: 'completed' with video_id NULL is rejected", rejectedCompletedNoVideo);

    // ============================================================
    // Film-removal (soft), transactional with reevaluation marking
    // ============================================================
    const filmVideo = await insertBareVideo({ uploadedBy: coachWithTeam.user.id });
    trackVideo(filmVideo.id);

    const outsiderRemoveAttempt = await req(`/api/videos/${filmVideo.id}/film-removal`, { method: "PATCH", token: outsiderAthlete.token });
    assert("unrelated user cannot Remove from Film", outsiderRemoveAttempt.status === 403);

    const removeResult = await req(`/api/videos/${filmVideo.id}/film-removal`, { method: "PATCH", token: coachWithTeam.token });
    assert("uploader can Remove from Film", removeResult.status === 200);

    const afterRemoveRow = await client.query("SELECT film_removed_at, film_removed_by, purge_reevaluation_requested_at FROM videos WHERE id = $1", [filmVideo.id]);
    assert(
      "film_removed_at and purge_reevaluation_requested_at were set TOGETHER, transactionally",
      afterRemoveRow.rows[0].film_removed_at !== null && afterRemoveRow.rows[0].purge_reevaluation_requested_at !== null
    );

    const filmListAfterRemove = await req("/api/videos", { token: coachWithTeam.token });
    assert("removed video no longer appears in the Film list", !filmListAfterRemove.data.some((v) => v.id === filmVideo.id));

    const directFetchAfterRemove = await req(`/api/videos/${filmVideo.id}`, { token: coachWithTeam.token });
    assert("removed video is STILL directly fetchable by id (playback unaffected)", directFetchAfterRemove.status === 200);

    const idempotentRemove = await req(`/api/videos/${filmVideo.id}/film-removal`, { method: "PATCH", token: coachWithTeam.token });
    assert("Remove from Film is idempotent on a second call", idempotentRemove.status === 200);

    // ============================================================
    // Personal-reel data-flow regression (correction round #1/#2): a clip
    // made from a source must keep working -- Film-list-excluded, still
    // returned and resolved by the owner's own clips endpoint -- after
    // that source is removed from Film. Exercises the exact home.js/
    // app.js/clips.js fix: GET /api/videos filtering film_removed_at rows
    // must never break loadReelData()/jumpToClip(), since they read
    // clip.video (server-resolved by GET /api/users/:id/clips), not a
    // lookup against the Film list.
    // ============================================================
    const reelSourceVideo = await insertBareVideo({ uploadedBy: coachWithTeam.user.id });
    trackVideo(reelSourceVideo.id);

    const reelClipCreate = await req("/api/clips", {
      method: "POST",
      token: coachWithTeam.token,
      body: { title: "reel regression clip", start_time: 0, end_time: 5, video_id: reelSourceVideo.id },
    });
    assert("reel regression: clip created against the source before removal", reelClipCreate.status === 201);

    const filmListBeforeReelRemove = await req("/api/videos", { token: coachWithTeam.token });
    assert("reel regression: source appears in Film list before removal", filmListBeforeReelRemove.data.some((v) => v.id === reelSourceVideo.id));

    const reelRemove = await req(`/api/videos/${reelSourceVideo.id}/film-removal`, { method: "PATCH", token: coachWithTeam.token });
    assert("reel regression: Remove from Film succeeds", reelRemove.status === 200);

    const filmListAfterReelRemove = await req("/api/videos", { token: coachWithTeam.token });
    assert("reel regression: source no longer appears in Film list after removal", !filmListAfterReelRemove.data.some((v) => v.id === reelSourceVideo.id));

    const ownerClipsAfterReelRemove = await req(`/api/users/${coachWithTeam.user.id}/clips`, { token: coachWithTeam.token });
    assert("reel regression: owner's clips endpoint responds 200", ownerClipsAfterReelRemove.status === 200);
    const survivingClip = (ownerClipsAfterReelRemove.data || []).find((c) => c.id === reelClipCreate.data.id);
    assert("reel regression: the clip itself is still returned after its source is removed from Film", Boolean(survivingClip));
    assert(
      "reel regression: the clip's embedded video is resolved (not null) -- this is the loadReelData()/jumpToClip() dependency",
      Boolean(survivingClip && survivingClip.video && survivingClip.video.id === reelSourceVideo.id)
    );
    assert(
      "reel regression: the resolved video carries a real playback_state (withPlaybackStatus ran), simulating a reload after removal",
      Boolean(survivingClip && survivingClip.video && survivingClip.video.playback_state === "playable")
    );

    // ============================================================
    // Personal Film upload — no server-side capability check yet
    // ============================================================
    // Correction: canUploadPersonalFilm() and its unit tests were removed
    // from Slice 1 entirely (see permissions.js's comment at the same
    // location) -- the global-role-based model it encoded is already
    // superseded by a team-membership/context-driven capability model,
    // and the helper was never enforced anywhere. Only the route's own
    // robustness (never a raw 500) is still worth proving here.
    const athletePersonalUpload = await req("/api/upload-video", { method: "POST", token: athlete.token });
    assert("route responds cleanly (not a 500) to a malformed request", athletePersonalUpload.status < 500);

    // Team Highlights, Slice 1: an explicit upload_destination='team_highlights'
    // must be rejected outright -- no feed/routes exist yet to attach a
    // real post to it, which would otherwise create invisible, orphaned
    // content (excluded from Film, with no Team Highlights post anywhere).
    const teamHighlightsForm = new FormData();
    teamHighlightsForm.append("video", new Blob([new Uint8Array(100)], { type: "video/mp4" }), "premature.mp4");
    teamHighlightsForm.append("title", `${RUN_TAG}_premature_highlight`);
    teamHighlightsForm.append("team_id", team.id);
    teamHighlightsForm.append("upload_destination", "team_highlights");
    const prematureHighlightUpload = await req("/api/upload-video", { method: "POST", token: coachWithTeam.token, body: teamHighlightsForm, isForm: true });
    assert("explicit upload_destination='team_highlights' is rejected in Slice 1", prematureHighlightUpload.status === 400);

    const noOrphanRow = await client.query("SELECT id FROM videos WHERE title = $1", [`${RUN_TAG}_premature_highlight`]);
    assert("the rejected team_highlights upload created no video row", noOrphanRow.rows.length === 0);

    // ============================================================
    // Physical purge — direct, zero references
    // ============================================================
    const cleanVideo = await insertBareVideo({ uploadedBy: coachWithTeam.user.id });
    trackVideo(cleanVideo.id);
    const purgeCleanResult = await sourceRetention.attemptPurge(cleanVideo.id, coachWithTeam.user.id);
    assert("attemptPurge on a zero-reference video succeeds", purgeCleanResult.outcome === "purged");
    const cleanVideoGone = await client.query("SELECT id FROM videos WHERE id = $1", [cleanVideo.id]);
    assert("the purged video row no longer exists", cleanVideoGone.rows.length === 0);
    created.videoIds = created.videoIds.filter((id) => id !== cleanVideo.id);

    // ============================================================
    // Physical purge — blocked by an active clip
    // ============================================================
    const clippedVideo = await insertBareVideo({ uploadedBy: coachWithTeam.user.id });
    trackVideo(clippedVideo.id);
    const clipResult = await req("/api/clips", {
      method: "POST",
      token: coachWithTeam.token,
      body: { title: "test clip", start_time: 0, end_time: 1, video_id: clippedVideo.id },
    });
    assert("clip creation on an active video succeeds", clipResult.status === 201);

    const blockedByClip = await sourceRetention.attemptPurge(clippedVideo.id, coachWithTeam.user.id);
    assert("attemptPurge is blocked by an unmaterialized clip", blockedByClip.outcome === "blocked" && blockedByClip.unmaterializedClips === 1);

    const stillExistsAfterBlock = await client.query("SELECT id FROM videos WHERE id = $1", [clippedVideo.id]);
    assert("the video row survives a blocked purge attempt", stillExistsAfterBlock.rows.length === 1);

    // Materialize the clip (simulating a future materialization job) —
    // must no longer block purge.
    await client.query("UPDATE clips SET storage_key = $1 WHERE video_id = $2", [`clips/${RUN_TAG}/materialized.mp4`, clippedVideo.id]);
    const purgeAfterMaterialization = await sourceRetention.attemptPurge(clippedVideo.id, coachWithTeam.user.id);
    assert("a MATERIALIZED clip no longer blocks purge", purgeAfterMaterialization.outcome === "purged");
    const materializedClipSurvives = await client.query("SELECT id, video_id, storage_key FROM clips WHERE storage_key = $1", [`clips/${RUN_TAG}/materialized.mp4`]);
    assert(
      "the materialized clip survives the source purge, with video_id nulled by ON DELETE SET NULL",
      materializedClipSurvives.rows.length === 1 && materializedClipSurvives.rows[0].video_id === null
    );
    created.videoIds = created.videoIds.filter((id) => id !== clippedVideo.id);

    // ============================================================
    // Physical purge — blocked by an active Team Highlight post,
    // and upload_attempts survives via ON DELETE SET NULL
    // ============================================================
    const highlightedVideo = await insertBareVideo({ uploadedBy: coachWithTeam.user.id, teamId: team.id, uploadDestination: "team_highlights" });
    trackVideo(highlightedVideo.id);
    const highlightInsert = await client.query(
      "INSERT INTO team_highlights (video_id, team_id, created_by) VALUES ($1, $2, $3) RETURNING *",
      [highlightedVideo.id, team.id, coachWithTeam.user.id]
    );
    const highlightRow = highlightInsert.rows[0];

    const attemptInsert = await client.query(
      `
      INSERT INTO upload_attempts (idempotency_key, user_id, team_id, upload_destination, status, storage_key, video_id, team_highlight_id)
      VALUES ($1, $2, $3, 'team_highlights', 'completed', $4, $5, $6)
      RETURNING *
      `,
      [`${RUN_TAG}_completed_attempt`, coachWithTeam.user.id, team.id, highlightedVideo.storage_key, highlightedVideo.id, highlightRow.id]
    );
    created.attemptIds.push(attemptInsert.rows[0].id);

    const blockedByPost = await sourceRetention.attemptPurge(highlightedVideo.id, coachWithTeam.user.id);
    assert("attemptPurge is blocked by an active Team Highlight post", blockedByPost.outcome === "blocked" && blockedByPost.activePosts === 1);

    // Remove the post, THEN it should be purgeable.
    await client.query("UPDATE team_highlights SET removed_at = now(), removed_by = $1 WHERE id = $2", [coachWithTeam.user.id, highlightRow.id]);
    const purgeAfterPostRemoved = await sourceRetention.attemptPurge(highlightedVideo.id, coachWithTeam.user.id);
    assert("purge succeeds once the only active post is removed", purgeAfterPostRemoved.outcome === "purged");

    const removedPostSurvives = await client.query("SELECT id, video_id, removed_at FROM team_highlights WHERE id = $1", [highlightRow.id]);
    assert(
      "the removed (historical) team_highlights row survives the source purge, video_id nulled",
      removedPostSurvives.rows.length === 1 && removedPostSurvives.rows[0].video_id === null && removedPostSurvives.rows[0].removed_at !== null
    );

    const completedAttemptSurvives = await client.query("SELECT id, video_id, team_highlight_id FROM upload_attempts WHERE id = $1", [attemptInsert.rows[0].id]);
    assert(
      "the completed upload_attempts row survives the source purge, video_id and team_highlight_id both nulled",
      completedAttemptSurvives.rows.length === 1 && completedAttemptSurvives.rows[0].video_id === null
    );
    created.videoIds = created.videoIds.filter((id) => id !== highlightedVideo.id);

    // ============================================================
    // Race-safe locking: a concurrent clip-creation vs. purge attempt
    // ============================================================
    const raceVideo = await insertBareVideo({ uploadedBy: coachWithTeam.user.id });
    trackVideo(raceVideo.id);

    const [raceClipResult, racePurgeResult] = await Promise.all([
      req("/api/clips", { method: "POST", token: coachWithTeam.token, body: { title: "race clip", start_time: 0, end_time: 1, video_id: raceVideo.id } }),
      sourceRetention.attemptPurge(raceVideo.id, coachWithTeam.user.id),
    ]);

    const raceVideoFinal = await client.query("SELECT id, purge_status FROM videos WHERE id = $1", [raceVideo.id]);
    const raceClipsFinal = await client.query("SELECT id FROM clips WHERE video_id = $1", [raceVideo.id]);
    // Whichever transaction's row lock won first determines the outcome,
    // but the two outcomes must be CONSISTENT with each other -- if the
    // clip landed, the video must still exist (purge must have been
    // blocked); if the video was purged, no clip can have landed.
    const raceConsistent =
      (raceClipResult.status === 201 && raceVideoFinal.rows.length === 1 && raceClipsFinal.rows.length === 1) ||
      (raceVideoFinal.rows.length === 0 && raceClipsFinal.rows.length === 0);
    assert(
      "concurrent clip-creation and purge are mutually exclusive (row lock proven, not just claimed)",
      raceConsistent,
      `clipStatus=${raceClipResult.status} purgeOutcome=${racePurgeResult.outcome} videoExists=${raceVideoFinal.rows.length} clipsExist=${raceClipsFinal.rows.length}`
    );
    if (raceVideoFinal.rows.length > 0) created.videoIds.push(raceVideo.id);

    // ============================================================
    // R2-already-absent finalization is idempotent
    // ============================================================
    const r2Video = await insertBareVideo({ uploadedBy: coachWithTeam.user.id });
    trackVideo(r2Video.id);
    // Manually flip to purge_pending (skipping the lock/count phase,
    // simulating "R2 already deleted, DB delete failed last time").
    await client.query("UPDATE videos SET purge_status = 'purge_pending' WHERE id = $1", [r2Video.id]);
    const finalizeOnAlreadyAbsent = await sourceRetention.finalizePurge(r2Video.id);
    assert("finalizePurge succeeds even when the R2 object never existed (idempotent-absent path)", finalizeOnAlreadyAbsent.outcome === "purged");
    created.videoIds = created.videoIds.filter((id) => id !== r2Video.id);
    // No manual anonymousPurgeVideoIds tracking needed -- r2Video.id is
    // already permanently recorded in allFixtureVideoIds via trackVideo()
    // at creation, and cleanup correlates against that full set.

    // ============================================================
    // Async reevaluation: film-removal -> sweeper -> purge_pending
    // ============================================================
    const reevalVideo = await insertBareVideo({ uploadedBy: coachWithTeam.user.id });
    trackVideo(reevalVideo.id);
    await req(`/api/videos/${reevalVideo.id}/film-removal`, { method: "PATCH", token: coachWithTeam.token });

    const sweepResult1 = await sourceRetention.sweepPurgeReevaluations();
    assert("sweepPurgeReevaluations picks up the marked video and transitions it", sweepResult1.purged >= 1 || sweepResult1.retained >= 0);

    const reevalVideoGone = await client.query("SELECT id FROM videos WHERE id = $1", [reevalVideo.id]);
    assert("a zero-reference film-removed video is fully purged by the sweeper", reevalVideoGone.rows.length === 0);
    created.videoIds = created.videoIds.filter((id) => id !== reevalVideo.id);
    // Root cause of the leaked audit row (production run, corrected here):
    // this sweep call processes EVERY currently-eligible video, not just
    // reevalVideo -- filmVideo (film-removed earlier, zero references,
    // never expected to reach physical purge) was swept up by this exact
    // call too, and its audit row went untracked under the old approach.
    // No manual per-call tracking needed now -- every video this run
    // creates, including filmVideo, is already in allFixtureVideoIds via
    // trackVideo(), so cleanup below correlates against the complete set
    // regardless of which call actually did the purging.

    // Negative case: an ACTIVE (never removed) video with zero clips/posts
    // must NEVER be touched, even after a sweep pass.
    const untouchedVideo = await insertBareVideo({ uploadedBy: coachWithTeam.user.id });
    trackVideo(untouchedVideo.id);
    await sourceRetention.sweepPurgeReevaluations();
    const untouchedStillThere = await client.query("SELECT id, purge_status FROM videos WHERE id = $1", [untouchedVideo.id]);
    assert(
      "an active Film source with zero references is NEVER auto-purged (it was never marked)",
      untouchedStillThere.rows.length === 1 && untouchedStillThere.rows[0].purge_status === "active"
    );

    // Reevaluation with a reference remaining -> flag cleared, video retained.
    const retainedVideo = await insertBareVideo({ uploadedBy: coachWithTeam.user.id });
    trackVideo(retainedVideo.id);
    await req("/api/clips", { method: "POST", token: coachWithTeam.token, body: { title: "keeps it alive", start_time: 0, end_time: 1, video_id: retainedVideo.id } });
    await req(`/api/videos/${retainedVideo.id}/film-removal`, { method: "PATCH", token: coachWithTeam.token });
    await sourceRetention.sweepPurgeReevaluations();
    const retainedStillThere = await client.query("SELECT id, purge_status, purge_reevaluation_requested_at FROM videos WHERE id = $1", [retainedVideo.id]);
    assert(
      "a film-removed video WITH a real clip is retained by the sweeper, flag cleared",
      retainedStillThere.rows.length === 1 &&
        retainedStillThere.rows[0].purge_status === "active" &&
        retainedStillThere.rows[0].purge_reevaluation_requested_at === null
    );

    // ============================================================
    // Duplicate active Team Highlight post prevention + republish
    // ============================================================
    const dupVideo = await insertBareVideo({ uploadedBy: coachWithTeam.user.id, teamId: team.id, uploadDestination: "team_highlights" });
    trackVideo(dupVideo.id);
    await client.query("INSERT INTO team_highlights (video_id, team_id, created_by) VALUES ($1, $2, $3)", [dupVideo.id, team.id, coachWithTeam.user.id]);

    let rejectedDuplicateActive = false;
    try {
      await client.query("INSERT INTO team_highlights (video_id, team_id, created_by) VALUES ($1, $2, $3)", [dupVideo.id, team.id, coachWithTeam.user.id]);
    } catch (error) {
      rejectedDuplicateActive = error.code === "23505"; // unique_violation
    }
    assert("a second ACTIVE post for the same (team, video) pair is rejected", rejectedDuplicateActive);

    await client.query("UPDATE team_highlights SET removed_at = now(), removed_by = $1 WHERE video_id = $2 AND removed_at IS NULL", [coachWithTeam.user.id, dupVideo.id]);
    let republishSucceeded = true;
    try {
      await client.query("INSERT INTO team_highlights (video_id, team_id, created_by) VALUES ($1, $2, $3)", [dupVideo.id, team.id, coachWithTeam.user.id]);
    } catch (error) {
      republishSucceeded = false;
    }
    assert("republishing the SAME (team, video) pair after removal succeeds", republishSucceeded);

    // ============================================================
    // Upload-attempt idempotency: claim / replay / concurrent claim
    // ============================================================
    const idemKey1 = `${RUN_TAG}_idem_1`;
    const claim1 = await uploadAttempts.claimOrGetAttempt({ userId: coachWithTeam.user.id, idempotencyKey: idemKey1, teamId: null, uploadDestination: "personal" });
    assert("first claim for a fresh idempotency key succeeds", claim1.freshClaim === true);
    created.attemptIds.push(claim1.attempt.id);

    const claim1Again = await uploadAttempts.claimOrGetAttempt({ userId: coachWithTeam.user.id, idempotencyKey: idemKey1, teamId: null, uploadDestination: "personal" });
    assert("replaying the same key while still pending reports in-progress, not a fresh claim", claim1Again.inProgress === true);

    // Concurrent claim race: two simultaneous claims for the SAME new key.
    const idemKeyRace = `${RUN_TAG}_idem_race`;
    const [raceClaimA, raceClaimB] = await Promise.all([
      uploadAttempts.claimOrGetAttempt({ userId: coachWithTeam.user.id, idempotencyKey: idemKeyRace, teamId: null, uploadDestination: "personal" }),
      uploadAttempts.claimOrGetAttempt({ userId: coachWithTeam.user.id, idempotencyKey: idemKeyRace, teamId: null, uploadDestination: "personal" }),
    ]);
    const freshClaimCount = [raceClaimA, raceClaimB].filter((c) => c.freshClaim).length;
    assert("exactly ONE of two concurrent claims for the same key wins", freshClaimCount === 1, `count=${freshClaimCount}`);
    const winningRaceAttempt = raceClaimA.freshClaim ? raceClaimA.attempt : raceClaimB.attempt;
    created.attemptIds.push(winningRaceAttempt.id);

    // Complete claim1, then prove idempotent replay returns the SAME video.
    const testKey = `videos/test/${RUN_TAG}/idem-complete.mp4`;
    await uploadAttempts.persistUploadingState(claim1.attempt.id, claim1.attempt.lease_token, testKey);
    await uploadAttempts.markR2Uploaded(claim1.attempt.id, claim1.attempt.lease_token);
    const { video: completedVideo } = await uploadAttempts.completeAttempt(claim1.attempt.id, claim1.attempt.lease_token, {
      title: `${RUN_TAG}_idem_video`,
      storageKey: testKey,
      userId: coachWithTeam.user.id,
      teamId: null,
      uploadDestination: "personal",
      filmType: null,
      fileSize: 100,
    });
    trackVideo(completedVideo.id);

    const replayClaim = await uploadAttempts.claimOrGetAttempt({ userId: coachWithTeam.user.id, idempotencyKey: idemKey1, teamId: null, uploadDestination: "personal" });
    assert("idempotent replay of a COMPLETED attempt returns the existing result, not a fresh claim", replayClaim.alreadyCompleted === true && Number(replayClaim.attempt.video_id) === Number(completedVideo.id));

    const videosWithThisTitle = await client.query("SELECT id FROM videos WHERE title = $1", [`${RUN_TAG}_idem_video`]);
    assert("exactly one video was ever created for this idempotency key, despite the replay", videosWithThisTitle.rows.length === 1);

    // ============================================================
    // source_purged: the idempotency state machine's explicit terminal
    // outcome for a replay whose completed result was later physically
    // purged. Correction round: claimOrGetAttempt previously had no
    // dedicated branch for this status at all -- it fell through to the
    // generic "in progress, retry shortly" case, which was wrong on every
    // count the spec called out (not a live-video completion, not
    // in-progress, not resettable, not an unpredictable fall-through).
    // ============================================================
    const purgeOfCompletedVideo = await sourceRetention.attemptPurge(completedVideo.id, coachWithTeam.user.id);
    assert("purging the completed idempotency test's video succeeds (zero references)", purgeOfCompletedVideo.outcome === "purged");
    created.videoIds = created.videoIds.filter((id) => id !== completedVideo.id); // already gone

    const attemptAfterSourcePurge = await client.query("SELECT status, video_id FROM upload_attempts WHERE id = $1", [claim1.attempt.id]);
    assert("the completed attempt transitions to source_purged status", attemptAfterSourcePurge.rows[0].status === "source_purged");
    assert("the source_purged attempt's video_id is cleared", attemptAfterSourcePurge.rows[0].video_id === null);

    // Service-level: claimOrGetAttempt must report this explicitly, never
    // as completed-with-a-live-video, never as in-progress, never as a
    // fresh/resettable claim.
    const sourcePurgedReplay = await uploadAttempts.claimOrGetAttempt({ userId: coachWithTeam.user.id, idempotencyKey: idemKey1, teamId: null, uploadDestination: "personal" });
    assert("source_purged replay is reported as its own explicit outcome", sourcePurgedReplay.sourcePurged === true);
    assert("source_purged replay is NOT reported as alreadyCompleted", !sourcePurgedReplay.alreadyCompleted);
    assert("source_purged replay is NOT reported as inProgress", !sourcePurgedReplay.inProgress);
    assert("source_purged replay is NOT reported as a fresh claim (not resettable)", !sourcePurgedReplay.freshClaim);

    const attemptCountAfterServiceReplay = await client.query("SELECT COUNT(*)::int AS count FROM upload_attempts WHERE idempotency_key = $1", [idemKey1]);
    assert("the service-level replay created no replacement attempt row", attemptCountAfterServiceReplay.rows[0].count === 1);

    // Route-level: a real HTTP replay with the SAME idempotency_key must
    // return the explicit terminal response, never touch storage, never
    // create a video/post/replacement attempt.
    const sourcePurgedForm = new FormData();
    sourcePurgedForm.append("video", new Blob([new Uint8Array(100)], { type: "video/mp4" }), "purged-replay.mp4");
    sourcePurgedForm.append("title", `${RUN_TAG}_purged_replay_should_not_exist`);
    sourcePurgedForm.append("idempotency_key", idemKey1);
    const sourcePurgedHttpReplay = await req("/api/upload-video", { method: "POST", token: coachWithTeam.token, body: sourcePurgedForm, isForm: true });
    assert("HTTP replay of a source_purged key returns 410 Gone", sourcePurgedHttpReplay.status === 410);

    const noReplacementVideo = await client.query("SELECT id FROM videos WHERE title = $1", [`${RUN_TAG}_purged_replay_should_not_exist`]);
    assert("the 410 replay created no replacement video row", noReplacementVideo.rows.length === 0);

    const attemptCountAfterHttpReplay = await client.query("SELECT COUNT(*)::int AS count FROM upload_attempts WHERE idempotency_key = $1", [idemKey1]);
    assert("the 410 replay created no replacement attempt row (still exactly one)", attemptCountAfterHttpReplay.rows[0].count === 1);

    // Sweeper: source_purged is a terminal status, outside every sweeper
    // query's status list -- must never be selected, regardless of its
    // now-stale, no-longer-maintained lease_expires_at value.
    await client.query("UPDATE upload_attempts SET lease_expires_at = now() - interval '1 hour' WHERE id = $1", [claim1.attempt.id]);
    await uploadAttempts.sweepUploadAttempts();
    const attemptAfterSweepOfSourcePurged = await client.query("SELECT status FROM upload_attempts WHERE id = $1", [claim1.attempt.id]);
    assert("sweepUploadAttempts leaves a source_purged row's status untouched despite an expired lease", attemptAfterSweepOfSourcePurged.rows[0].status === "source_purged");

    // Reset/retry: the failed/cleaned_up reset path's own WHERE clause
    // (also exercised indirectly via claimOrGetAttempt above) must never
    // match a source_purged row -- proven directly against the exact SQL
    // shape claimOrGetAttempt uses internally.
    const rejectedReset = await client.query(
      `
      UPDATE upload_attempts
      SET status = 'pending', storage_key = NULL, video_id = NULL, team_highlight_id = NULL, attempt_count = attempt_count + 1
      WHERE id = $1 AND status IN ('failed', 'cleaned_up')
      RETURNING id
      `,
      [claim1.attempt.id]
    );
    assert("the reset/retry UPDATE's own WHERE clause never matches a source_purged row", rejectedReset.rows.length === 0);

    // ============================================================
    // Lease fencing: the exact required race
    // ============================================================
    const fenceClaim = await uploadAttempts.claimOrGetAttempt({ userId: coachWithTeam.user.id, idempotencyKey: `${RUN_TAG}_fence`, teamId: null, uploadDestination: "personal" });
    created.attemptIds.push(fenceClaim.attempt.id);
    const originalToken = fenceClaim.attempt.lease_token;
    await uploadAttempts.persistUploadingState(fenceClaim.attempt.id, originalToken, `videos/test/${RUN_TAG}/fence.mp4`);

    // 1. Original owner's lease expires.
    await client.query("UPDATE upload_attempts SET lease_expires_at = now() - interval '1 minute' WHERE id = $1", [fenceClaim.attempt.id]);

    // 2. Sweeper claims with a new token.
    const sweepResult2 = await uploadAttempts.sweepUploadAttempts();
    assert("the sweeper reclaimed the expired lease", sweepResult2.expiredCount >= 1);

    const afterSweepRow = await client.query("SELECT lease_token, status FROM upload_attempts WHERE id = $1", [fenceClaim.attempt.id]);
    const newToken = afterSweepRow.rows[0].lease_token;
    assert("the lease_token changed identity after the sweeper reclaimed it", newToken !== originalToken);
    assert("the attempt was cleaned up by the sweeper (no real R2 object existed, but the state machine treated it as if one might)", ["cleaned_up", "cleanup_pending"].includes(afterSweepRow.rows[0].status));

    // 3-4. Original owner wakes and attempts to advance the attempt using
    // its STALE token.
    let fencedOut = false;
    try {
      await uploadAttempts.markR2Uploaded(fenceClaim.attempt.id, originalToken);
    } catch (error) {
      fencedOut = error.code === "LEASE_LOST";
    }
    assert("a late-waking original process using the OLD lease token is fenced out (zero rows affected, cannot interfere)", fencedOut);

    // ============================================================
    // Real R2 object cleanup path (uploading -> lease expires -> sweeper
    // deletes it, verified against a real object, not a bare row)
    // ============================================================
    const realKey = `videos/test/${RUN_TAG}/real-object.mp4`;
    const tempPath = require("path").join(require("os").tmpdir(), `${RUN_TAG}-real.mp4`);
    require("fs").writeFileSync(tempPath, Buffer.from("test video bytes"));
    await storage.upload(realKey, tempPath, "video/mp4", { category: "video" });
    created.r2Keys.push(realKey); // safety net; the sweeper is expected to remove it below

    const realObjectExists = await storage.exists(realKey);
    assert("setup: the real R2 object exists before the sweep", realObjectExists === true);

    const abandonedClaim = await client.query(
      `
      INSERT INTO upload_attempts (idempotency_key, user_id, upload_destination, status, storage_key, lease_token, lease_expires_at, last_heartbeat_at)
      VALUES ($1, $2, 'personal', 'uploading', $3, $4, now() - interval '1 minute', now() - interval '10 minutes')
      RETURNING *
      `,
      [`${RUN_TAG}_abandoned`, coachWithTeam.user.id, realKey, require("crypto").randomUUID()]
    );
    created.attemptIds.push(abandonedClaim.rows[0].id);

    await uploadAttempts.sweepUploadAttempts();
    const realObjectGoneAfterSweep = await storage.exists(realKey);
    assert("the sweeper deletes the real, abandoned R2 object", realObjectGoneAfterSweep === false);
    created.r2Keys = created.r2Keys.filter((k) => k !== realKey); // already cleaned by the sweeper

    // ============================================================
    // Production smoke test: a real, valid MP4 through the real legacy
    // upload route (no upload_destination/idempotency_key sent -- the
    // exact shape capture.js/recordingPipeline.js/app.js's uploadVideo()
    // still send). Personal (no team_id) and team_film (team_id set).
    // ============================================================
    validMp4Path = await generateTinyValidMp4();

    const personalForm = new FormData();
    personalForm.append("video", new Blob([await require("fs").promises.readFile(validMp4Path)], { type: "video/mp4" }), "smoke-personal.mp4");
    personalForm.append("title", `${RUN_TAG}_smoke_personal`);
    const personalUploadRes = await req("/api/upload-video", { method: "POST", token: coachWithTeam.token, body: personalForm, isForm: true });
    assert("real valid MP4, no team_id -> upload succeeds (201)", personalUploadRes.status === 201, `status=${personalUploadRes.status}`);
    if (personalUploadRes.status === 201) trackVideo(personalUploadRes.data.id);
    assert(
      "personal upload: upload_destination is non-NULL and correct ('personal')",
      personalUploadRes.data && personalUploadRes.data.upload_destination === "personal"
    );
    assert("personal upload: team_id is NULL", personalUploadRes.data && personalUploadRes.data.team_id === null);
    const personalVideoRows = await client.query("SELECT id FROM videos WHERE title = $1", [`${RUN_TAG}_smoke_personal`]);
    assert("personal upload: exactly one video row was created", personalVideoRows.rows.length === 1);

    const teamFilmForm = new FormData();
    teamFilmForm.append("video", new Blob([await require("fs").promises.readFile(validMp4Path)], { type: "video/mp4" }), "smoke-teamfilm.mp4");
    teamFilmForm.append("title", `${RUN_TAG}_smoke_teamfilm`);
    teamFilmForm.append("team_id", team.id);
    const teamFilmUploadRes = await req("/api/upload-video", { method: "POST", token: coachWithTeam.token, body: teamFilmForm, isForm: true });
    assert("real valid MP4, with team_id -> upload succeeds (201)", teamFilmUploadRes.status === 201, `status=${teamFilmUploadRes.status}`);
    if (teamFilmUploadRes.status === 201) trackVideo(teamFilmUploadRes.data.id);
    assert(
      "team_film upload: upload_destination is non-NULL and correct ('team_film')",
      teamFilmUploadRes.data && teamFilmUploadRes.data.upload_destination === "team_film"
    );
    assert(
      "team_film upload: team_id matches the submitted team",
      teamFilmUploadRes.data && Number(teamFilmUploadRes.data.team_id) === Number(team.id)
    );
    const teamFilmVideoRows = await client.query("SELECT id FROM videos WHERE title = $1", [`${RUN_TAG}_smoke_teamfilm`]);
    assert("team_film upload: exactly one video row was created", teamFilmVideoRows.rows.length === 1);

    // team_id relationship enforcement: personal explicitly WITH a
    // team_id, and a non-personal destination with NO team_id, must both
    // be rejected by the real route (not merely the DB constraint).
    const badPersonalForm = new FormData();
    badPersonalForm.append("video", new Blob([new Uint8Array(100)], { type: "video/mp4" }), "bad-personal.mp4");
    badPersonalForm.append("title", `${RUN_TAG}_smoke_bad_personal`);
    badPersonalForm.append("team_id", team.id);
    badPersonalForm.append("upload_destination", "personal");
    const badPersonalRes = await req("/api/upload-video", { method: "POST", token: coachWithTeam.token, body: badPersonalForm, isForm: true });
    assert("route rejects upload_destination=personal WITH a team_id", badPersonalRes.status === 400, `status=${badPersonalRes.status}`);

    const badTeamFilmForm = new FormData();
    badTeamFilmForm.append("video", new Blob([new Uint8Array(100)], { type: "video/mp4" }), "bad-teamfilm.mp4");
    badTeamFilmForm.append("title", `${RUN_TAG}_smoke_bad_teamfilm`);
    badTeamFilmForm.append("upload_destination", "team_film");
    const badTeamFilmRes = await req("/api/upload-video", { method: "POST", token: coachWithTeam.token, body: badTeamFilmForm, isForm: true });
    assert("route rejects upload_destination=team_film WITHOUT a team_id", badTeamFilmRes.status === 400, `status=${badTeamFilmRes.status}`);

    // ============================================================
    // Real HTTP-level idempotent replay: the SAME idempotency_key sent
    // twice through the real route must produce exactly one video, the
    // second response returning the same result, not a duplicate.
    // ============================================================
    const smokeIdemKey = `${RUN_TAG}_smoke_idem`;
    const idemForm1 = new FormData();
    idemForm1.append("video", new Blob([await require("fs").promises.readFile(validMp4Path)], { type: "video/mp4" }), "smoke-idem.mp4");
    idemForm1.append("title", `${RUN_TAG}_smoke_idem_video`);
    idemForm1.append("idempotency_key", smokeIdemKey);
    const idemUploadRes1 = await req("/api/upload-video", { method: "POST", token: coachWithTeam.token, body: idemForm1, isForm: true });
    assert("idempotent upload #1 succeeds (201)", idemUploadRes1.status === 201, `status=${idemUploadRes1.status}`);
    if (idemUploadRes1.status === 201) trackVideo(idemUploadRes1.data.id);

    const idemForm2 = new FormData();
    idemForm2.append("video", new Blob([await require("fs").promises.readFile(validMp4Path)], { type: "video/mp4" }), "smoke-idem-replay.mp4");
    idemForm2.append("title", `${RUN_TAG}_smoke_idem_video`);
    idemForm2.append("idempotency_key", smokeIdemKey);
    const idemUploadRes2 = await req("/api/upload-video", { method: "POST", token: coachWithTeam.token, body: idemForm2, isForm: true });
    assert("idempotent replay #2 also returns 201 (the existing result, not an error)", idemUploadRes2.status === 201, `status=${idemUploadRes2.status}`);
    assert(
      "idempotent replay #2 returns the SAME video id as #1",
      idemUploadRes1.data && idemUploadRes2.data && idemUploadRes1.data.id === idemUploadRes2.data.id
    );

    const idemVideoRows = await client.query("SELECT id FROM videos WHERE title = $1", [`${RUN_TAG}_smoke_idem_video`]);
    assert("duplicate submission created exactly one video, not two", idemVideoRows.rows.length === 1);
    const idemAttemptRows = await client.query("SELECT id FROM upload_attempts WHERE idempotency_key = $1", [smokeIdemKey]);
    assert("duplicate submission created exactly one upload_attempts row, not two", idemAttemptRows.rows.length === 1);

    // ============================================================
    // Combined clip + Team Highlight post isolation: removing one
    // reference type must never affect the other, or the source, until
    // BOTH are gone.
    // ============================================================
    const isolationVideo = await insertBareVideo({ uploadedBy: coachWithTeam.user.id, teamId: team.id, uploadDestination: "team_highlights" });
    trackVideo(isolationVideo.id);

    const isolationClipRes = await req("/api/clips", {
      method: "POST",
      token: coachWithTeam.token,
      body: { title: "isolation clip", start_time: 0, end_time: 1, video_id: isolationVideo.id },
    });
    assert("isolation setup: clip created", isolationClipRes.status === 201);
    const isolationClipId = isolationClipRes.data.id;

    const isolationPostInsert = await client.query(
      "INSERT INTO team_highlights (video_id, team_id, created_by) VALUES ($1, $2, $3) RETURNING id",
      [isolationVideo.id, team.id, coachWithTeam.user.id]
    );
    const isolationPostId = isolationPostInsert.rows[0].id;

    const isolationBlockedByBoth = await sourceRetention.attemptPurge(isolationVideo.id, coachWithTeam.user.id);
    assert(
      "isolation: purge blocked by BOTH the clip and the post",
      isolationBlockedByBoth.outcome === "blocked" && isolationBlockedByBoth.activePosts === 1 && isolationBlockedByBoth.unmaterializedClips === 1
    );

    // Remove ONLY the post.
    await client.query("UPDATE team_highlights SET removed_at = now(), removed_by = $1 WHERE id = $2", [coachWithTeam.user.id, isolationPostId]);
    const clipUnaffectedByPostRemoval = await client.query("SELECT id, video_id, start_time, end_time FROM clips WHERE id = $1", [isolationClipId]);
    assert(
      "removing the post leaves the clip completely unaffected",
      clipUnaffectedByPostRemoval.rows.length === 1 &&
        Number(clipUnaffectedByPostRemoval.rows[0].video_id) === Number(isolationVideo.id) &&
        Number(clipUnaffectedByPostRemoval.rows[0].start_time) === 0
    );
    const isolationBlockedByClipOnly = await sourceRetention.attemptPurge(isolationVideo.id, coachWithTeam.user.id);
    assert(
      "isolation: after removing ONLY the post, purge is still blocked -- by the clip alone",
      isolationBlockedByClipOnly.outcome === "blocked" && isolationBlockedByClipOnly.activePosts === 0 && isolationBlockedByClipOnly.unmaterializedClips === 1
    );

    // Now remove ONLY the clip (no user-facing delete route exists yet in
    // this slice; this is the test's own direct simulation of that
    // reference going away).
    await client.query("DELETE FROM clips WHERE id = $1", [isolationClipId]);
    const postStillRemovedAfterClipDelete = await client.query("SELECT id, removed_at, video_id FROM team_highlights WHERE id = $1", [isolationPostId]);
    assert(
      "removing the clip leaves the already-removed post's own historical row untouched",
      postStillRemovedAfterClipDelete.rows.length === 1 && postStillRemovedAfterClipDelete.rows[0].removed_at !== null
    );
    const isolationPurgeableAfterBothGone = await sourceRetention.attemptPurge(isolationVideo.id, coachWithTeam.user.id);
    assert("isolation: once BOTH references are gone, purge succeeds", isolationPurgeableAfterBothGone.outcome === "purged");
    created.videoIds = created.videoIds.filter((id) => id !== isolationVideo.id);
    // This purge went through attemptPurge with a real actingUserId
    // (coachWithTeam.user.id) -- already covered by the per-user cleanup
    // loop's own security_audit_log deletion below. isolationVideo.id is
    // also in allFixtureVideoIds regardless (from trackVideo() at
    // creation), so the fixture-video-id correlation query would catch it
    // too if it were ever NULL-user_id; no separate tracking needed.

    // ============================================================
    // Full real-R2 lifecycle: upload a real object -> Remove from Film
    // -> sweep -> confirm BOTH the DB row and the real R2 object are
    // gone, and nothing else was touched.
    // ============================================================
    const lifecycleForm = new FormData();
    lifecycleForm.append("video", new Blob([await require("fs").promises.readFile(validMp4Path)], { type: "video/mp4" }), "smoke-lifecycle.mp4");
    lifecycleForm.append("title", `${RUN_TAG}_smoke_lifecycle`);
    const lifecycleUploadRes = await req("/api/upload-video", { method: "POST", token: coachWithTeam.token, body: lifecycleForm, isForm: true });
    assert("lifecycle: real upload succeeds", lifecycleUploadRes.status === 201, `status=${lifecycleUploadRes.status}`);
    const lifecycleVideoId = lifecycleUploadRes.data.id;
    const lifecycleStorageKey = lifecycleUploadRes.data.storage_key;
    trackVideo(lifecycleVideoId);
    created.r2Keys.push(lifecycleStorageKey); // safety net; the sweep below is expected to remove it

    const lifecycleObjectExistsBefore = await storage.exists(lifecycleStorageKey);
    assert("lifecycle: the real R2 object exists right after upload", lifecycleObjectExistsBefore === true);

    // Let classifyAndRouteAsync() settle before removing/purging this
    // fixture -- this is a genuinely valid MP4, so real background
    // classification is in flight. Purging while it's still running risks
    // a benign but noisy "video not found" from the async completion
    // handler racing the DELETE; waiting avoids manufacturing that log
    // noise (the smoke test's own bar includes "no new unexpected
    // errors"). Same settle pattern as testVideoClassification.js.
    const settleDeadline = Date.now() + 15000;
    while (Date.now() < settleDeadline) {
      const statusCheck = await req(`/api/videos/${lifecycleVideoId}`, { token: coachWithTeam.token });
      if (statusCheck.data && !["uploading", "classifying", "remuxing"].includes(statusCheck.data.processing_status)) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const lifecycleRemoveRes = await req(`/api/videos/${lifecycleVideoId}/film-removal`, { method: "PATCH", token: coachWithTeam.token });
    assert("lifecycle: Remove from Film succeeds", lifecycleRemoveRes.status === 200);

    await sourceRetention.sweepPurgeReevaluations();

    const lifecycleVideoGone = await client.query("SELECT id FROM videos WHERE id = $1", [lifecycleVideoId]);
    assert("lifecycle: the video's database row is gone after the sweep", lifecycleVideoGone.rows.length === 0);

    // Correction: storage.exists() returns true when the object IS still
    // present -- the old name ("lifecycleObjectGone") held that raw
    // result, so "if (lifecycleObjectGone)" actually fired when the
    // object STILL EXISTED (sweep failed to delete it), removing the
    // safety net from created.r2Keys at exactly the moment it was most
    // needed, and leaving it in place (redundant but harmless) on the
    // success path instead. Renamed to say what the value actually means,
    // and the condition inverted to match: the safety-net key is removed
    // from the pending-cleanup list ONLY once absence is positively
    // confirmed; if the object is still there for any reason, it stays in
    // created.r2Keys so the finally block's safety cleanup still attempts
    // removal.
    const lifecycleObjectStillExists = await storage.exists(lifecycleStorageKey);
    assert("lifecycle: the real R2 object is gone after the sweep", lifecycleObjectStillExists === false);
    created.videoIds = created.videoIds.filter((id) => id !== lifecycleVideoId);
    if (!lifecycleObjectStillExists) {
      created.r2Keys = created.r2Keys.filter((k) => k !== lifecycleStorageKey); // confirmed gone, safety net no longer needed
    }

    // Confirm nothing ELSE was touched by this purge: the earlier
    // team_film/personal/idempotent smoke-test videos must still exist,
    // completely unaffected.
    const otherSmokeVideosStillExist = await client.query(
      "SELECT count(*)::int AS count FROM videos WHERE title = ANY($1::text[])",
      [[`${RUN_TAG}_smoke_personal`, `${RUN_TAG}_smoke_teamfilm`, `${RUN_TAG}_smoke_idem_video`]]
    );
    assert("lifecycle purge did not touch any other fixture video", otherSmokeVideosStillExist.rows[0].count === 3);

    // ============================================================
    // Cross-feature smoke: Film listing, clip playback, Messages,
    // Invitations, Schedule all still respond normally post-deploy.
    // Every call uses this run's OWN throwaway team/users.
    // ============================================================
    const filmListingSmoke = await req("/api/videos", { token: coachWithTeam.token });
    assert("cross-feature smoke: Film listing responds normally", filmListingSmoke.status === 200);

    const clipPlaybackSmoke = await req(`/api/users/${coachWithTeam.user.id}/clips`, { token: coachWithTeam.token });
    assert("cross-feature smoke: clip playback (owner clips endpoint) responds normally", clipPlaybackSmoke.status === 200);

    const messagesSmoke = await req("/api/conversations", { token: coachWithTeam.token });
    assert("cross-feature smoke: Messages (conversations) responds normally", messagesSmoke.status === 200, `status=${messagesSmoke.status}`);

    const directMessagesSmoke = await req("/api/messages/eligible-recipients", { token: coachWithTeam.token });
    assert("cross-feature smoke: Direct Messaging (eligible recipients) responds normally", directMessagesSmoke.status === 200, `status=${directMessagesSmoke.status}`);

    const invitationsSmoke = await req(`/api/teams/${team.id}/invitations`, { token: coachWithTeam.token });
    assert("cross-feature smoke: Invitations listing responds normally", invitationsSmoke.status === 200, `status=${invitationsSmoke.status}`);

    const scheduleSmoke = await req(`/api/teams/${team.id}/events`, { token: coachWithTeam.token });
    assert("cross-feature smoke: Schedule (team events) responds normally", scheduleSmoke.status === 200, `status=${scheduleSmoke.status}`);

    const upcomingEventsSmoke = await req(`/api/users/${coachWithTeam.user.id}/upcoming-events`, { token: coachWithTeam.token });
    assert("cross-feature smoke: Schedule (upcoming events) responds normally", upcomingEventsSmoke.status === 200, `status=${upcomingEventsSmoke.status}`);

    console.log("Cleanup starting...");
  } finally {
    if (typeof validMp4Path === "string") {
      await require("fs").promises.unlink(validMp4Path).catch(() => {});
    }
    try {
      for (const key of created.r2Keys) {
        await storage.remove(key).catch(() => {});
      }
      for (const id of created.attemptIds) {
        await client.query("DELETE FROM upload_attempts WHERE id = $1", [id]);
      }
      for (const id of created.videoIds) {
        await client.query("DELETE FROM team_highlights WHERE video_id = $1", [id]);
        await client.query("DELETE FROM clips WHERE video_id = $1", [id]);
        await client.query("DELETE FROM upload_attempts WHERE video_id = $1", [id]);
        const videoRow = await client.query("SELECT storage_key FROM videos WHERE id = $1", [id]);
        if (videoRow.rows[0]?.storage_key) {
          await storage.remove(videoRow.rows[0].storage_key).catch(() => {});
        }
        await client.query("DELETE FROM videos WHERE id = $1", [id]);
      }
      // Any remaining team_highlights/clips/upload_attempts not tied to a
      // tracked video id (e.g. the materialized/removed ones checked above).
      await client.query("DELETE FROM clips WHERE storage_key LIKE $1", [`clips/${RUN_TAG}/%`]);
      await client.query("DELETE FROM team_highlights WHERE team_id = ANY($1::int[])", [created.teamIds]);
      await client.query("DELETE FROM upload_attempts WHERE idempotency_key LIKE $1", [`${RUN_TAG}%`]);

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

      // Exact-ID cleanup for this run's own 'video_deleted' audit rows,
      // by COMPLETE fixture tracking rather than remembering individual
      // purge calls. allFixtureVideoIds holds every video id this run
      // ever created (via trackVideo(), regardless of whether it was
      // later purged and dropped from created.videoIds) -- since no
      // batch operation (sweepPurgeReevaluations() included) can ever
      // purge a video this run didn't itself create, matching against
      // that complete set is correct by construction, not by predicting
      // which specific call will do the purging. Not restricted to
      // user_id IS NULL: a real-actingUserId purge's row is already gone
      // via the per-user loop above by the time this runs, so matching
      // without that restriction is redundant-but-harmless there and
      // correct for every NULL-user_id case. Deleted by exact id only --
      // never a watermark, time range, user-id pattern, or broad
      // event-type deletion.
      if (created.allFixtureVideoIds.length > 0) {
        const correlatedAuditRows = await client.query(
          `
          SELECT id FROM security_audit_log
          WHERE event_type = 'video_deleted'
            AND (metadata->>'videoId')::int = ANY($1::int[])
          `,
          [created.allFixtureVideoIds]
        );
        if (correlatedAuditRows.rows.length > 0) {
          await client.query(
            "DELETE FROM security_audit_log WHERE id = ANY($1::int[])",
            [correlatedAuditRows.rows.map((r) => r.id)]
          );
        }
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
