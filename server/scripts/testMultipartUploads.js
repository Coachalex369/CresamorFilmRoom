/*
  testMultipartUploads.js — Phase A acceptance script for the resumable,
  direct-to-R2 upload sprint (see the "Resumable, Direct-to-R2 Mobile Video
  Uploads" plan). Same shape as testInvitations.js/testAuth.js: plain Node,
  real app on a throwaway local port, real fetch() calls (including real
  PUTs straight to R2 via the presigned URLs this script's own initiate
  calls mint), RUN_TAG-namespaced rows, full cleanup in a finally block.

  This is entirely small-synthetic-file, server/script-only verification --
  Stage 1 of the plan's staged test sequence. It does NOT touch a browser
  and does NOT stand in for the real-device Stage 2-5 tests, which need
  actual video files and actual mobile hardware.

  Requires STORAGE_PROVIDER=r2 and real R2 credentials in the environment
  (this hits the real bucket) -- there is no local-disk equivalent for
  multipart uploads (see r2Storage.js's comment on why).

  Run by hand:
    ALLOW_PRODUCTION_TESTS=true STORAGE_PROVIDER=r2 node server/scripts/testMultipartUploads.js
*/

require("dotenv").config();

const { requireProductionTestOptIn } = require("./lib/requireProductionTestOptIn");
requireProductionTestOptIn("testMultipartUploads.js");

// Fails fast with one clear line instead of cascading through dozens of
// downstream assertion failures (an early "initiate" call failing on a
// missing credential still lets every later req() call resolve normally --
// this script's own helpers don't throw on an HTTP error status -- so
// without this check, a misconfigured environment silently produces a
// long, confusing FAIL list instead of an obvious root cause). Same
// early-exit convention as backfillR2.js's STORAGE_PROVIDER check.
const REQUIRED_R2_ENV_VARS = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME"];
if (process.env.STORAGE_PROVIDER !== "r2") {
  console.error("STORAGE_PROVIDER is not 'r2' -- this script exercises real R2 multipart uploads, run with STORAGE_PROVIDER=r2.");
  process.exit(1);
}
const missingR2Vars = REQUIRED_R2_ENV_VARS.filter((name) => !process.env[name]);
if (missingR2Vars.length) {
  console.error(
    `Missing R2 env var(s): ${missingR2Vars.join(", ")}. These aren't in every local .env by default (only ` +
      "Render's production environment has them) -- see ARCHITECTURE.md's \"Manual Cloudflare setup\" for where " +
      "to find the values, then add them to the local .env before running this script."
  );
  process.exit(1);
}

const crypto = require("crypto");

const app = require("../app");
const client = require("../db/client");
const storage = require("../services/storage/storage");
const { sweepAbandonedUploads } = require("../services/uploadSweep");

const PORT = 3991;
const BASE_URL = `http://localhost:${PORT}`;
const RUN_TAG = `mpupload_${Date.now()}`;

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

// Uploads every part of `buffer` for an already-initiated session, PUTting
// straight to R2 via this script's own real HTTP calls to the presign
// endpoint -- exactly the round-trip a real browser client will do, minus
// concurrency/retry (this script is testing correctness, not the client's
// scheduling logic, which lives in multipartUploader.js on a later phase).
async function uploadAllParts(token, uploadId, buffer, partSize, partCount) {
  const parts = [];

  for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
    const start = (partNumber - 1) * partSize;
    const end = Math.min(start + partSize, buffer.length);
    const chunk = buffer.subarray(start, end);

    const presignRes = await req(`/api/video-uploads/${uploadId}/parts/${partNumber}/presign`, { method: "POST", token });
    if (presignRes.status !== 200) {
      throw new Error(`Presign failed for part ${partNumber}: ${presignRes.status} ${JSON.stringify(presignRes.data)}`);
    }

    const putResponse = await fetch(presignRes.data.url, { method: "PUT", body: chunk });
    if (!putResponse.ok) {
      throw new Error(`R2 PUT failed for part ${partNumber}: ${putResponse.status}`);
    }

    const etag = putResponse.headers.get("etag");
    if (!etag) throw new Error(`No ETag returned for part ${partNumber} -- check R2 CORS ExposeHeaders`);

    parts.push({ partNumber, etag });
  }

  return parts;
}

async function main() {
  const created = { userIds: [], videoIds: [], uploadIds: [], storageKeys: [], teamIds: [] };
  const server = app.listen(PORT);
  // Declared here, not with `const` inside the try block below -- a
  // binding created with const/let inside try {} does not exist in the
  // paired finally {} block at all (not merely uninitialized -- a
  // ReferenceError). The finally block's cleanup needs a token to call the
  // abort endpoint with, so this has to live at function scope like
  // `created` above, assigned once coach is actually registered.
  let coachToken = null;

  try {
    const coach = await registerUser(`${RUN_TAG}-coach@test.cresamor.local`, "coach");
    coachToken = coach.token;
    created.userIds.push(coach.user.id);
    const otherUser = await registerUser(`${RUN_TAG}-other@test.cresamor.local`, "athlete");
    created.userIds.push(otherUser.user.id);

    // A valid, authorized team_id is required by every initiate call below
    // -- unassigned multipart uploads aren't authorized yet (beta scope),
    // so this team has to exist before any of the other tests can even
    // reach the behavior they're actually testing. POST /api/teams
    // auto-joins the creator as role_on_team='coach'.
    const teamRes = await req("/api/teams", {
      method: "POST",
      token: coach.token,
      body: { name: `${RUN_TAG} Team`, sport: "Wrestling" },
    });
    assert("coach creates the team used throughout this script", teamRes.status === 201, JSON.stringify(teamRes.data));
    const teamId = teamRes.data.id;
    created.teamIds.push(teamId);

    // ---- Happy path: initiate -> presign+PUT every part -> complete ----
    const fileSize = 25 * 1024 * 1024 + 137; // multiple parts, uneven last part
    const fileBuffer = crypto.randomBytes(fileSize);

    const initiateRes = await req("/api/video-uploads/initiate", {
      method: "POST",
      token: coach.token,
      body: {
        title: `${RUN_TAG} happy path`,
        file_name: "synthetic.mp4",
        file_size: fileSize,
        content_type: "video/mp4",
        team_id: teamId,
        last_modified: Date.now(),
      },
    });
    assert("initiate returns 201", initiateRes.status === 201, JSON.stringify(initiateRes.data));
    const { uploadId, storageKey, partSize, partCount } = initiateRes.data;
    created.uploadIds.push(uploadId);
    created.storageKeys.push(storageKey);
    assert("initiate computes the expected part count", partCount === Math.ceil(fileSize / partSize), `partCount=${partCount} partSize=${partSize}`);

    const parts = await uploadAllParts(coach.token, uploadId, fileBuffer, partSize, partCount);
    assert("uploaded a real ETag for every part", parts.every((p) => Boolean(p.etag)));

    const completeRes = await req(`/api/video-uploads/${uploadId}/complete`, {
      method: "POST",
      token: coach.token,
      body: { parts },
    });
    assert("complete returns 201 with a video row", completeRes.status === 201 && completeRes.data.id, JSON.stringify(completeRes.data));
    const videoId = completeRes.data.id;
    created.videoIds.push(videoId);
    assert("completed video has storage_key matching the session", completeRes.data.storage_key === storageKey);

    const liveSize = await storage.getObjectSize(storageKey);
    assert("final R2 object is byte-exact", liveSize === fileSize, `expected=${fileSize} actual=${liveSize}`);

    // ---- Safe session IDs: the client never sees R2's own UploadId ----
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    assert("client-facing uploadId is a UUID (session_id), not R2's own id", UUID_RE.test(uploadId), uploadId);

    const dbRow = await client.query("SELECT r2_upload_id FROM video_uploads WHERE session_id = $1", [uploadId]);
    const rawR2UploadId = dbRow.rows[0].r2_upload_id;
    assert("r2_upload_id and session_id are genuinely different values", rawR2UploadId !== uploadId);

    const statusRes = await req(`/api/video-uploads/${uploadId}`, { token: coach.token });
    const leaked =
      JSON.stringify(initiateRes.data).includes(rawR2UploadId) ||
      JSON.stringify(completeRes.data).includes(rawR2UploadId) ||
      JSON.stringify(statusRes.data).includes(rawR2UploadId);
    assert("R2's raw UploadId never appears in any API response", !leaked);

    // ---- Idempotent re-completion: same call again must not double-insert ----
    const recompleteRes = await req(`/api/video-uploads/${uploadId}/complete`, {
      method: "POST",
      token: coach.token,
      body: { parts },
    });
    assert("retried complete returns 200, same video id, no duplicate", recompleteRes.status === 200 && recompleteRes.data.id === videoId, JSON.stringify(recompleteRes.data));

    const videoCountRes = await client.query("SELECT COUNT(*) FROM videos WHERE storage_key = $1", [storageKey]);
    assert("exactly one videos row exists for this storage_key", Number(videoCountRes.rows[0].count) === 1, videoCountRes.rows[0].count);

    // ---- Rejected completion: wrong ETag must not silently succeed ----
    const badPartsInitiate = await req("/api/video-uploads/initiate", {
      method: "POST",
      token: coach.token,
      body: {
        title: `${RUN_TAG} bad etag`,
        file_name: "bad.mp4",
        file_size: 6 * 1024 * 1024,
        content_type: "video/mp4",
        team_id: teamId,
        last_modified: Date.now(),
      },
    });
    created.uploadIds.push(badPartsInitiate.data.uploadId);
    created.storageKeys.push(badPartsInitiate.data.storageKey);
    const badBuffer = crypto.randomBytes(6 * 1024 * 1024);
    const realParts = await uploadAllParts(
      coach.token,
      badPartsInitiate.data.uploadId,
      badBuffer,
      badPartsInitiate.data.partSize,
      badPartsInitiate.data.partCount
    );
    const tamperedParts = realParts.map((p, i) => (i === 0 ? { ...p, etag: '"0000000000000000000000000000000"' } : p));
    const badCompleteRes = await req(`/api/video-uploads/${badPartsInitiate.data.uploadId}/complete`, {
      method: "POST",
      token: coach.token,
      body: { parts: tamperedParts },
    });
    assert("completion with a wrong ETag is rejected, not trusted", badCompleteRes.status === 409, JSON.stringify(badCompleteRes.data));

    // That session is still in_progress -- clean it up via a real abort so
    // it doesn't rely on the sweep test below.
    const goodCompleteRes = await req(`/api/video-uploads/${badPartsInitiate.data.uploadId}/complete`, {
      method: "POST",
      token: coach.token,
      body: { parts: realParts },
    });
    assert("retrying completion with the real parts afterward succeeds", goodCompleteRes.status === 201, JSON.stringify(goodCompleteRes.data));
    created.videoIds.push(goodCompleteRes.data.id);

    // ---- Explicit cancel/abort ----
    const abortInitiate = await req("/api/video-uploads/initiate", {
      method: "POST",
      token: coach.token,
      body: {
        title: `${RUN_TAG} to be aborted`,
        file_name: "abort-me.mp4",
        file_size: 1024,
        content_type: "video/mp4",
        team_id: teamId,
        last_modified: Date.now(),
      },
    });
    created.uploadIds.push(abortInitiate.data.uploadId);
    created.storageKeys.push(abortInitiate.data.storageKey);

    const abortRes = await req(`/api/video-uploads/${abortInitiate.data.uploadId}/abort`, { method: "POST", token: coach.token });
    assert("abort succeeds", abortRes.status === 200 && abortRes.data.success === true);

    const presignAfterAbort = await req(`/api/video-uploads/${abortInitiate.data.uploadId}/parts/1/presign`, { method: "POST", token: coach.token });
    assert("presign after abort is rejected (409)", presignAfterAbort.status === 409);

    const doubleAbort = await req(`/api/video-uploads/${abortInitiate.data.uploadId}/abort`, { method: "POST", token: coach.token });
    assert("aborting an already-aborted session is a safe no-op", doubleAbort.status === 200 && doubleAbort.data.success === true);

    // ---- Ownership isolation: another authenticated user can't touch it ----
    const crossUserPresign = await req(`/api/video-uploads/${initiateRes.data.uploadId}/parts/1/presign`, { method: "POST", token: otherUser.token });
    assert("a different user gets 404, not the real session state", crossUserPresign.status === 404);

    const crossUserAbort = await req(`/api/video-uploads/${initiateRes.data.uploadId}/abort`, { method: "POST", token: otherUser.token });
    assert("a different user cannot abort someone else's session", crossUserAbort.status === 404);

    // ---- Team-upload authorization ---- (teamId created up front, above)
    const assistantCoach = await registerUser(`${RUN_TAG}-assistant@test.cresamor.local`, "athlete");
    created.userIds.push(assistantCoach.user.id);
    const parentMember = await registerUser(`${RUN_TAG}-parent@test.cresamor.local`, "parent");
    created.userIds.push(parentMember.user.id);

    await req(`/api/users/${assistantCoach.user.id}/teams`, {
      method: "POST",
      token: coach.token,
      body: { team_id: teamId, role_on_team: "assistant_coach" },
    });
    await req(`/api/users/${parentMember.user.id}/teams`, {
      method: "POST",
      token: coach.token,
      body: { team_id: teamId, role_on_team: "parent" },
    });

    // Positive control: an active Assistant Coach CAN target the team's Film Room.
    const assistantInitiate = await req("/api/video-uploads/initiate", {
      method: "POST",
      token: assistantCoach.token,
      body: {
        title: `${RUN_TAG} assistant coach upload`,
        file_name: "assistant.mp4",
        file_size: 1024,
        content_type: "video/mp4",
        team_id: teamId,
        last_modified: Date.now(),
      },
    });
    assert("an active Assistant Coach can target the team's Film Room", assistantInitiate.status === 201, JSON.stringify(assistantInitiate.data));
    created.uploadIds.push(assistantInitiate.data.uploadId);
    created.storageKeys.push(assistantInitiate.data.storageKey);

    // Explicit cleanup, owned by assistantCoach (not coach) -- the
    // finally block's generic abort-sweep below only has coach's token
    // available and would 404 (not the owner) trying to abort this one,
    // silently leaving its R2 multipart upload dangling otherwise. Safe to
    // abort now even though the revoked-membership test below still runs
    // against this same team: abort only checks video_uploads ownership
    // (who created THIS session), not current team_members standing, so
    // revoking assistantCoach's team role afterward doesn't affect it.
    await req(`/api/video-uploads/${assistantInitiate.data.uploadId}/abort`, { method: "POST", token: assistantCoach.token });

    // A team-scoped Parent is deliberately NOT authorized for this
    // endpoint -- parent uploads are a separate future "Team Highlights"
    // surface, not the general Film Room this feature targets.
    const parentInitiate = await req("/api/video-uploads/initiate", {
      method: "POST",
      token: parentMember.token,
      body: {
        title: `${RUN_TAG} parent upload attempt`,
        file_name: "parent.mp4",
        file_size: 1024,
        content_type: "video/mp4",
        team_id: teamId,
        last_modified: Date.now(),
      },
    });
    assert("a team-scoped Parent cannot target the general Film Room", parentInitiate.status === 403, JSON.stringify(parentInitiate.data));

    // A user with no relationship to the team at all cannot target it by
    // guessing/knowing its numeric id -- the original vulnerability.
    const unrelatedInitiate = await req("/api/video-uploads/initiate", {
      method: "POST",
      token: otherUser.token,
      body: {
        title: `${RUN_TAG} unrelated user upload attempt`,
        file_name: "unrelated.mp4",
        file_size: 1024,
        content_type: "video/mp4",
        team_id: teamId,
        last_modified: Date.now(),
      },
    });
    assert("an unrelated user cannot target another team by id", unrelatedInitiate.status === 403, JSON.stringify(unrelatedInitiate.data));

    // Revoked membership must lose upload authority immediately, same
    // guarantee canAccessTeam/canManageTeam already provide everywhere else.
    const revokeRes = await req(`/api/teams/${teamId}/members/${assistantCoach.user.id}`, {
      method: "DELETE",
      token: coach.token,
    });
    assert("coach can revoke the assistant coach's membership", revokeRes.status === 200, JSON.stringify(revokeRes.data));

    const revokedInitiate = await req("/api/video-uploads/initiate", {
      method: "POST",
      token: assistantCoach.token,
      body: {
        title: `${RUN_TAG} revoked assistant coach attempt`,
        file_name: "revoked.mp4",
        file_size: 1024,
        content_type: "video/mp4",
        team_id: teamId,
        last_modified: Date.now(),
      },
    });
    assert("a revoked Assistant Coach can no longer target the team", revokedInitiate.status === 403, JSON.stringify(revokedInitiate.data));

    // ---- Unassigned multipart uploads are not authorized yet: team_id
    // is required, and team_id: null must not be usable to dodge the
    // canUploadToTeam() check entirely (the actual bypass this closes). ----
    const parentNullTeam = await req("/api/video-uploads/initiate", {
      method: "POST",
      token: parentMember.token,
      body: {
        title: `${RUN_TAG} parent null team bypass attempt`,
        file_name: "parent-null.mp4",
        file_size: 1024,
        content_type: "video/mp4",
        team_id: null,
        last_modified: Date.now(),
      },
    });
    assert(
      "a Parent cannot bypass team authorization by sending team_id: null",
      parentNullTeam.status === 400,
      JSON.stringify(parentNullTeam.data)
    );

    const unrelatedNullTeam = await req("/api/video-uploads/initiate", {
      method: "POST",
      token: otherUser.token,
      body: {
        title: `${RUN_TAG} unrelated null team bypass attempt`,
        file_name: "unrelated-null.mp4",
        file_size: 1024,
        content_type: "video/mp4",
        team_id: null,
        last_modified: Date.now(),
      },
    });
    assert(
      "an unrelated user cannot bypass team authorization by sending team_id: null",
      unrelatedNullTeam.status === 400,
      JSON.stringify(unrelatedNullTeam.data)
    );

    // Same result with team_id omitted entirely, and true even for a real
    // Coach -- unassigned multipart uploads are categorically not
    // authorized yet, not merely gated behind a role check.
    const coachNoTeam = await req("/api/video-uploads/initiate", {
      method: "POST",
      token: coach.token,
      body: {
        title: `${RUN_TAG} coach omitted team`,
        file_name: "coach-no-team.mp4",
        file_size: 1024,
        content_type: "video/mp4",
        last_modified: Date.now(),
      },
    });
    assert(
      "even a Coach cannot start an unassigned multipart upload right now",
      coachNoTeam.status === 400,
      JSON.stringify(coachNoTeam.data)
    );

    // ---- Validation: oversized / unsupported content type rejected up front ----
    const tooLargeRes = await req("/api/video-uploads/initiate", {
      method: "POST",
      token: coach.token,
      body: {
        title: `${RUN_TAG} too large`,
        file_name: "huge.mp4",
        file_size: (Number(process.env.MAX_VIDEO_UPLOAD_MB) || 3072) * 1024 * 1024 + 1,
        content_type: "video/mp4",
        last_modified: Date.now(),
      },
    });
    assert("a file over MAX_VIDEO_UPLOAD_MB is rejected at initiate", tooLargeRes.status === 400);

    const badTypeRes = await req("/api/video-uploads/initiate", {
      method: "POST",
      token: coach.token,
      body: {
        title: `${RUN_TAG} bad type`,
        file_name: "not-a-video.exe",
        file_size: 1024,
        content_type: "application/x-msdownload",
        last_modified: Date.now(),
      },
    });
    assert("an unsupported content type is rejected at initiate", badTypeRes.status === 400);

    // ---- Orphan sweep: an old in_progress session gets aborted ----
    const sweepInitiate = await req("/api/video-uploads/initiate", {
      method: "POST",
      token: coach.token,
      body: {
        title: `${RUN_TAG} to be swept`,
        file_name: "orphan.mp4",
        file_size: 1024,
        content_type: "video/mp4",
        team_id: teamId,
        last_modified: Date.now(),
      },
    });
    created.uploadIds.push(sweepInitiate.data.uploadId);
    created.storageKeys.push(sweepInitiate.data.storageKey);

    // Genuinely inactive: both created_at AND updated_at (the sweep's real
    // signal) are old -- nothing has touched this session in 48 hours.
    await client.query(
      "UPDATE video_uploads SET created_at = now() - interval '48 hours', updated_at = now() - interval '48 hours' WHERE session_id = $1",
      [sweepInitiate.data.uploadId]
    );

    // ---- A session that STARTED long ago but is still ACTIVE must survive ----
    // Simulates a legitimate hour-plus upload or a next-day resume that's
    // still progressing: old created_at, but updated_at bumped recently
    // (exactly what a presign/status call does in real usage). Sweeping on
    // created_at alone would destroy this; sweeping on updated_at must not.
    const stillActiveInitiate = await req("/api/video-uploads/initiate", {
      method: "POST",
      token: coach.token,
      body: {
        title: `${RUN_TAG} old but still active`,
        file_name: "still-active.mp4",
        file_size: 1024,
        content_type: "video/mp4",
        team_id: teamId,
        last_modified: Date.now(),
      },
    });
    created.uploadIds.push(stillActiveInitiate.data.uploadId);
    created.storageKeys.push(stillActiveInitiate.data.storageKey);

    await client.query(
      "UPDATE video_uploads SET created_at = now() - interval '48 hours', updated_at = now() - interval '5 minutes' WHERE session_id = $1",
      [stillActiveInitiate.data.uploadId]
    );

    const sweepResult = await sweepAbandonedUploads();
    assert("sweep aborted at least the deliberately-inactive session", sweepResult.swept >= 1, JSON.stringify(sweepResult));

    const sweptRow = await client.query("SELECT status FROM video_uploads WHERE session_id = $1", [sweepInitiate.data.uploadId]);
    assert("the genuinely inactive session's status is now aborted", sweptRow.rows[0].status === "aborted");

    const stillActiveRow = await client.query("SELECT status FROM video_uploads WHERE session_id = $1", [stillActiveInitiate.data.uploadId]);
    assert(
      "the old-but-recently-active session survives the sweep untouched",
      stillActiveRow.rows[0].status === "in_progress",
      stillActiveRow.rows[0].status
    );

    const presignAfterSweep = await req(`/api/video-uploads/${sweepInitiate.data.uploadId}/parts/1/presign`, { method: "POST", token: coach.token });
    assert("presign after sweep is rejected (409)", presignAfterSweep.status === 409);

    const presignStillActive = await req(`/api/video-uploads/${stillActiveInitiate.data.uploadId}/parts/1/presign`, { method: "POST", token: coach.token });
    assert("presign on the still-active session keeps working after the sweep", presignStillActive.status === 200, JSON.stringify(presignStillActive.data));

    // Explicit cleanup for the still-active session (it wasn't swept, so
    // the finally block's storage.remove alone would leave the R2
    // multipart upload itself dangling).
    await req(`/api/video-uploads/${stillActiveInitiate.data.uploadId}/abort`, { method: "POST", token: coach.token });
  } finally {
    try {
      // Real R2 cleanup for any session this run didn't already complete
      // or explicitly abort -- goes through the actual abort endpoint
      // (which knows the real r2_upload_id and calls
      // AbortMultipartUploadCommand) rather than skipping straight to
      // deleting the video_uploads row. Deleting the DB row directly
      // without this would leave the underlying R2 multipart upload
      // itself dangling with no tracking row left to catch it via the
      // sweep -- exactly the storage-cost problem this feature exists to
      // prevent. Best-effort: a session that already completed (409) or
      // was already aborted (200, no-op) or never got far enough to exist
      // at all (404) are all fine to ignore here.
      for (const sessionId of created.uploadIds) {
        if (!sessionId || !coachToken) continue;
        await req(`/api/video-uploads/${sessionId}/abort`, { method: "POST", token: coachToken }).catch(() => {});
      }

      for (const key of created.storageKeys) {
        await storage.remove(key).catch(() => {});
      }
      // video_uploads.video_id references videos(id) with no ON DELETE
      // clause -- video_uploads must be deleted FIRST, or deleting videos
      // while a video_uploads row still points at it violates the FK.
      // video_uploads.team_id also references teams(id), so this also has
      // to run before the team loop below deletes the teams row itself.
      await client.query("DELETE FROM video_uploads WHERE session_id = ANY($1::uuid[])", [created.uploadIds]);
      await client.query("DELETE FROM videos WHERE id = ANY($1::int[])", [created.videoIds]);
      // Team rows: torn down by exact created.teamIds only, before the
      // users loop below -- teams.created_by / team_members.user_id both
      // reference users(id), so users can't be deleted first, and this
      // script's own team(s) must be gone before the broader per-user
      // team_members sweep in that loop runs (that sweep is a safety net
      // for any stray rows, not the primary mechanism).
      for (const id of created.teamIds) {
        // Messages team-scoping: POST /api/teams auto-creates a
        // conversation for the team, which FK-references it -- must be
        // torn down before the team row itself can be deleted (same
        // pattern as testInvitations.js's cleanup).
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
        await client.query("DELETE FROM security_audit_log WHERE user_id = $1", [id]);
        await client.query("DELETE FROM conversation_participants WHERE user_id = $1", [id]);
        await client.query("DELETE FROM team_members WHERE user_id = $1", [id]);
        await client.query("DELETE FROM users WHERE id = $1", [id]);
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
