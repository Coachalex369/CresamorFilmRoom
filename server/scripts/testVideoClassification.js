/*
  testVideoClassification.js — Play-First Video Pipeline acceptance script.
  Same shape as testVideoVisibility.js/testAuth.js: real app on a
  throwaway local port, real HTTP requests, clearly-namespaced test data,
  cleaned up in a finally block regardless of pass/fail.

  Uploads three small, real (ffprobe-readable) fixture files exercising
  each branch of classifyVideo()'s matrix:
    - playable.mp4  — H.264/AAC already in an MP4 container -> 'playable'
    - remuxable.mov — same codecs, wrapped in .MOV -> 'remux' -> 'ready'
    - bogus.mp4     — not a real video at all -> ffprobe fails -> 'transcode_needed' -> 'transcode_paused'

  Fixtures are generated on the fly (not committed to the repo) via the
  local ffmpeg binary if present; the script skips gracefully with a clear
  message if ffmpeg/ffprobe aren't on PATH, rather than failing opaquely.

  Run by hand: ALLOW_PRODUCTION_TESTS=true node server/scripts/testVideoClassification.js
*/

require("dotenv").config();

const { requireProductionTestOptIn } = require("./lib/requireProductionTestOptIn");
requireProductionTestOptIn("testVideoClassification.js");

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const app = require("../app");
const client = require("../db/client");
const storage = require("../services/storage/storage");
const videoConversion = require("../services/videoConversion");
const {
  __performStrandedConversionRecoveryForTests: performStrandedConversionRecovery,
} = require("../services/videoProcessing");

const PORT = 3992;
const BASE_URL = `http://localhost:${PORT}`;
const RUN_TAG = `videoclass_${Date.now()}`;

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
  return data;
}

async function uploadVideo(token, { title, filePath, mimeType }) {
  const bytes = await fs.promises.readFile(filePath);
  const form = new FormData();
  form.append("video", new Blob([bytes], { type: mimeType }), path.basename(filePath));
  form.append("title", title);

  const { status, data } = await req("/api/upload-video", { method: "POST", token, body: form, isForm: true });
  if (status !== 201) throw new Error(`Upload failed: ${status} ${JSON.stringify(data)}`);
  return data;
}

// Polls until processing_status leaves every transient state, or times
// out. Classification+remux resolves in low single-digit seconds (proven
// against a real 654MB production file: ~2s for a remux); 'queued'/
// 'converting' (Android HEVC playback fix's real transcode path) added
// after those became reachable states too — a small synthetic fixture's
// real libx264 encode is still fast, but a generous ceiling leaves
// headroom without letting a genuine hang stall the whole suite.
async function waitForSettledStatus(token, videoId, { timeoutMs = 20000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data } = await req(`/api/videos/${videoId}`, { token });
    if (!["uploading", "classifying", "remuxing", "queued", "converting"].includes(data.processing_status)) {
      return data;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Video ${videoId} did not settle within ${timeoutMs}ms`);
}

async function generateFixtures(dir) {
  await execFileAsync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=320x240:rate=15",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    path.join(dir, "playable.mp4"),
  ]);
  await execFileAsync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=320x240:rate=15",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-pix_fmt", "yuv420p",
    path.join(dir, "remuxable.mov"),
  ]);
  await fs.promises.writeFile(path.join(dir, "bogus.mp4"), crypto.randomBytes(2000));

  // Android HEVC playback fix: a real, ffprobe-readable HEVC/AAC/MP4
  // fixture -- Chad's real Android uploads (videos 525/526/662) all
  // classified exactly this shape (video_codec=hevc, audio_codec=aac,
  // container=mp4). -tag:v hvc1 matches what a real Android device
  // actually writes (vs. ffmpeg's default hev1 tag) -- not load-bearing
  // for classification (which reads codec_name, not the tag), but keeps
  // the fixture representative of the real-world file this exists to fix.
  await execFileAsync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=640x360:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-c:v", "libx265", "-tag:v", "hvc1", "-pix_fmt", "yuv420p", "-c:a", "aac",
    path.join(dir, "hevc.mp4"),
  ]);

  // Same HEVC codec, but frame rate deliberately exceeds
  // videoConversion.js's PREFLIGHT_MAX_FPS (60) -- classifies identically
  // to hevc.mp4 (transcode_needed), but the REAL transcode attempt must
  // fail at the preflight-probe stage, before ffmpeg/R2 ever run. Used to
  // prove a controlled transcode failure lands at 'failed' (not stuck
  // forever) and that retrying it afterward doesn't duplicate anything.
  await execFileAsync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=320x240:rate=90",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-c:v", "libx265", "-tag:v", "hvc1", "-pix_fmt", "yuv420p", "-c:a", "aac",
    path.join(dir, "hevc_toofast.mp4"),
  ]);
}

async function main() {
  const created = { userIds: [], videoIds: [] };
  const server = app.listen(PORT);
  const fixtureDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "videoclass-fixtures-"));

  try {
    try {
      await execFileAsync("ffmpeg", ["-version"]);
      await execFileAsync("ffprobe", ["-version"]);
    } catch {
      console.log(
        "SKIPPED — ffmpeg/ffprobe not found on PATH in this environment. " +
          "This script needs them locally to generate test fixtures; the real " +
          "server environment (Render) has them preinstalled, per videoConversion.js's header."
      );
      return;
    }

    await generateFixtures(fixtureDir);

    const coach = await registerUser(`${RUN_TAG}_coach@test.cresamor.local`, "coach");
    created.userIds.push(coach.user.id);

    // --- Case 1: already MP4/H.264/AAC -> 'playable', ready immediately, no new object ---
    const playableUpload = await uploadVideo(coach.token, {
      title: `${RUN_TAG}_playable`,
      filePath: path.join(fixtureDir, "playable.mp4"),
      mimeType: "video/mp4",
    });
    created.videoIds.push(playableUpload.id);

    const playableSettled = await waitForSettledStatus(coach.token, playableUpload.id);
    assert(
      "already-MP4/H.264/AAC classifies as 'playable' and becomes ready",
      playableSettled.processing_status === "ready" && playableSettled.classification === "playable",
      `status=${playableSettled.processing_status} classification=${playableSettled.classification}`
    );
    assert(
      "playable case: playback_state is 'playable'",
      playableSettled.playback_state === "playable"
    );
    assert(
      "playable case: original object is untouched (no source_storage_key set)",
      !playableSettled.source_storage_key
    );
    assert(
      "playable case: video_codec/audio_codec recorded",
      playableSettled.video_codec === "h264" && playableSettled.audio_codec === "aac",
      `video_codec=${playableSettled.video_codec} audio_codec=${playableSettled.audio_codec}`
    );

    // --- Case 2: H.264/AAC in .MOV -> 'remux' -> 'ready', original preserved ---
    const remuxUpload = await uploadVideo(coach.token, {
      title: `${RUN_TAG}_remuxable`,
      filePath: path.join(fixtureDir, "remuxable.mov"),
      mimeType: "video/quicktime",
    });
    created.videoIds.push(remuxUpload.id);
    const originalStorageKey = remuxUpload.storage_key;

    const remuxSettled = await waitForSettledStatus(coach.token, remuxUpload.id, { timeoutMs: 30000 });
    assert(
      "MOV-wrapped H.264/AAC classifies as 'remux' and becomes ready",
      remuxSettled.processing_status === "ready" && remuxSettled.classification === "remux",
      `status=${remuxSettled.processing_status} classification=${remuxSettled.classification}`
    );
    assert(
      "remux case: playback_state is 'playable'",
      remuxSettled.playback_state === "playable"
    );
    assert(
      "remux case: original object preserved via source_storage_key",
      remuxSettled.source_storage_key === originalStorageKey,
      `source_storage_key=${remuxSettled.source_storage_key} original=${originalStorageKey}`
    );
    assert(
      "remux case: storage_key changed to the new remuxed object",
      remuxSettled.storage_key !== originalStorageKey
    );

    // --- Case 3: not a real video -> ffprobe fails at classification time
    // -> 'transcode_needed' -> now ALSO fails ffprobe again at the real
    // transcode's preflight stage (Android HEVC playback fix: transcode_needed
    // now actually attempts a transcode, not just a permanent park) -> 'failed'.
    // This is a genuine behavior change from before that fix landed, and a
    // more honest one: a truly corrupt/unreadable file is not "waiting on a
    // worker", it's a real processing failure with a clear Retry affordance --
    // never silently stuck at the same paused state forever. ---
    const bogusUpload = await uploadVideo(coach.token, {
      title: `${RUN_TAG}_bogus`,
      filePath: path.join(fixtureDir, "bogus.mp4"),
      mimeType: "video/mp4",
    });
    created.videoIds.push(bogusUpload.id);

    const bogusSettled = await waitForSettledStatus(coach.token, bogusUpload.id);
    assert(
      "unreadable file classifies as 'transcode_needed', then genuinely fails the real transcode attempt",
      bogusSettled.processing_status === "failed" && bogusSettled.classification === "transcode_needed",
      `status=${bogusSettled.processing_status} classification=${bogusSettled.classification}`
    );
    assert(
      "failed case: playback_state is 'failed', with a clear Retry affordance client-side, never a silent dead end",
      bogusSettled.playback_state === "failed"
    );
    assert(
      "failed case: a specific processing_error is recorded, not left blank",
      typeof bogusSettled.processing_error === "string" && bogusSettled.processing_error.length > 0,
      `processing_error=${bogusSettled.processing_error}`
    );
    assert(
      "failed case: original object is still preserved and available (a failed transcode never touches the source)",
      bogusSettled.available === true
    );

    // --- Retry-classification endpoint still works for this now-'failed' row ---
    const retryRes = await req(`/api/videos/${bogusUpload.id}/retry-classification`, {
      method: "POST",
      token: coach.token,
    });
    assert("retry-classification succeeds for a failed video", retryRes.status === 200, `status=${retryRes.status}`);

    // --- Case 4 (Android HEVC playback fix): genuine HEVC/AAC/MP4 ->
    // 'transcode_needed' -> real transcode via the legacy convertOne()/
    // convertVideo() machinery, now wired to this classification -> 'ready'.
    // Chad's real Android uploads (videos 525/526/662) all classified
    // exactly this shape. ---
    const hevcUpload = await uploadVideo(coach.token, {
      title: `${RUN_TAG}_hevc`,
      filePath: path.join(fixtureDir, "hevc.mp4"),
      mimeType: "video/mp4",
    });
    created.videoIds.push(hevcUpload.id);
    const hevcOriginalStorageKey = hevcUpload.storage_key;

    const hevcSettled = await waitForSettledStatus(coach.token, hevcUpload.id, { timeoutMs: 30000 });
    assert(
      "genuine HEVC/AAC/MP4 classifies as transcode_needed and the real transcode reaches 'ready'",
      hevcSettled.processing_status === "ready" && hevcSettled.classification === "transcode_needed",
      `status=${hevcSettled.processing_status} classification=${hevcSettled.classification}`
    );
    assert("HEVC case: playback_state is 'playable'", hevcSettled.playback_state === "playable");
    assert(
      "HEVC case: original object preserved via source_storage_key",
      hevcSettled.source_storage_key === hevcOriginalStorageKey,
      `source_storage_key=${hevcSettled.source_storage_key} original=${hevcOriginalStorageKey}`
    );
    assert("HEVC case: storage_key changed to the new transcoded object", hevcSettled.storage_key !== hevcOriginalStorageKey);
    assert(
      "HEVC case: derived key is deterministic ({videoId}-h264.mp4), not a random UUID",
      hevcSettled.storage_key === `videos/unassigned/${new Date(hevcSettled.created_at).getFullYear()}/${hevcUpload.id}-h264.mp4`,
      `storage_key=${hevcSettled.storage_key}`
    );

    const originalStillExists = await storage.exists(hevcOriginalStorageKey);
    assert("HEVC case: original source object still exists in storage (never deleted)", originalStillExists === true);

    // Probe the ACTUAL derived object, not just trust the DB's stale
    // video_codec column (convertOne() deliberately doesn't rewrite it,
    // same convention as the remux case above) -- proves a real transcode
    // happened, not just a key swap or relabeled copy.
    const derivedLocalPath = path.join(fixtureDir, "hevc_derived_probe.mp4");
    await storage.downloadToFile(hevcSettled.storage_key, derivedLocalPath);
    const { stdout: derivedProbeOut } = await execFileAsync("ffprobe", [
      "-v", "error", "-show_entries", "stream=codec_name,codec_type", "-of", "json", derivedLocalPath,
    ]);
    const derivedProbe = JSON.parse(derivedProbeOut);
    const derivedVideoCodec = derivedProbe.streams.find((s) => s.codec_type === "video")?.codec_name;
    const derivedAudioCodec = derivedProbe.streams.find((s) => s.codec_type === "audio")?.codec_name;
    assert(
      "HEVC case: the derived object actually IS H.264/AAC now (real transcode, not a relabeled copy)",
      derivedVideoCodec === "h264" && derivedAudioCodec === "aac",
      `derived video_codec=${derivedVideoCodec} audio_codec=${derivedAudioCodec}`
    );
    assert(
      "HEVC case: video_codec/audio_codec columns still describe the SOURCE (unchanged by conversion, same convention as remux)",
      hevcSettled.video_codec === "hevc" && hevcSettled.audio_codec === "aac"
    );

    // --- Case 5: controlled transcode failure (real HEVC, but frame rate
    // exceeds videoConversion.js's preflight bound) -> 'failed', proving a
    // real transcode failure is surfaced honestly and doesn't strand the
    // video at a silent paused state. ---
    const tooFastUpload = await uploadVideo(coach.token, {
      title: `${RUN_TAG}_hevc_toofast`,
      filePath: path.join(fixtureDir, "hevc_toofast.mp4"),
      mimeType: "video/mp4",
    });
    created.videoIds.push(tooFastUpload.id);

    const tooFastSettled = await waitForSettledStatus(coach.token, tooFastUpload.id, { timeoutMs: 30000 });
    assert(
      "HEVC exceeding the preflight fps bound fails the real transcode attempt (not silently skipped)",
      tooFastSettled.processing_status === "failed" && tooFastSettled.classification === "transcode_needed",
      `status=${tooFastSettled.processing_status} classification=${tooFastSettled.classification}`
    );
    assert(
      "controlled-failure case: processing_error names the preflight rejection specifically",
      /preflight/i.test(tooFastSettled.processing_error || ""),
      `processing_error=${tooFastSettled.processing_error}`
    );

    const countBeforeRetry = (
      await client.query("SELECT count(*) FROM videos WHERE title = $1", [`${RUN_TAG}_hevc_toofast`])
    ).rows[0].count;
    await req(`/api/videos/${tooFastUpload.id}/retry-classification`, { method: "POST", token: coach.token });
    const tooFastRetrySettled = await waitForSettledStatus(coach.token, tooFastUpload.id, { timeoutMs: 30000 });
    const countAfterRetry = (
      await client.query("SELECT count(*) FROM videos WHERE title = $1", [`${RUN_TAG}_hevc_toofast`])
    ).rows[0].count;

    assert(
      "retry after a controlled transcode failure does not duplicate the video row",
      countBeforeRetry === "1" && countAfterRetry === "1",
      `before=${countBeforeRetry} after=${countAfterRetry}`
    );
    assert(
      "retry after a controlled transcode failure reaches the same deterministic outcome",
      tooFastRetrySettled.processing_status === "failed"
    );

    // --- Direct idempotency proof: two separate convertVideo() calls for
    // the SAME video row produce the IDENTICAL derived key both times, and
    // the second (an overwrite of the same key) succeeds cleanly -- the
    // exact guarantee a crash-then-resume retry depends on to never
    // orphan an R2/local object. ---
    const idemUpload = await uploadVideo(coach.token, {
      title: `${RUN_TAG}_hevc_idem`,
      filePath: path.join(fixtureDir, "hevc.mp4"),
      mimeType: "video/mp4",
    });
    created.videoIds.push(idemUpload.id);
    await waitForSettledStatus(coach.token, idemUpload.id, { timeoutMs: 30000 });

    const idemRow = (await client.query("SELECT * FROM videos WHERE id = $1", [idemUpload.id])).rows[0];
    const { newKey: idemKey1 } = await videoConversion.convertVideo(idemRow);
    const { newKey: idemKey2 } = await videoConversion.convertVideo({ ...idemRow, storage_key: idemKey1 });
    assert(
      "convertVideo() produces the identical deterministic key on a second call for the same video (idempotent overwrite, never a new orphaned object)",
      idemKey1 === idemKey2,
      `first=${idemKey1} second=${idemKey2}`
    );

    // --- Case 6: restart recovery. A row stranded at 'converting'
    // (simulating a crashed process mid-transcode) resumes via the SAME
    // performStrandedConversionRecovery() the legacy .mov path already
    // relies on -- zero new recovery code, since convertOne() now
    // recognizes BOTH triggers through the identical 'converting' status
    // and classification column, and the deterministic key above means
    // resuming never leaves a second derived object behind. ---
    const strandedKey = `${RUN_TAG}/stranded-source.mp4`;
    const strandedFixtureCopy = path.join(fixtureDir, "stranded-source-copy.mp4");
    await fs.promises.copyFile(path.join(fixtureDir, "hevc.mp4"), strandedFixtureCopy);
    await storage.upload(strandedKey, strandedFixtureCopy, "video/mp4", { category: "video" });
    const strandedSourceSize = await storage.getObjectSize(strandedKey);

    const strandedInsert = await client.query(
      `INSERT INTO videos (title, storage_key, uploaded_by, processing_status, classification, video_codec, audio_codec, container, source_size_bytes, upload_destination)
       VALUES ($1, $2, $3, 'converting', 'transcode_needed', 'hevc', 'aac', 'mp4', $4, 'personal') RETURNING *`,
      [`${RUN_TAG}_stranded`, strandedKey, coach.user.id, strandedSourceSize]
    );
    const strandedVideoId = strandedInsert.rows[0].id;
    created.videoIds.push(strandedVideoId);

    // Scoped to exactly this row's id, same structural safety as
    // testConversionRecovery.js -- never the unguarded call against a
    // real database without this filter.
    await performStrandedConversionRecovery([strandedVideoId]);
    const strandedSettled = await waitForSettledStatus(coach.token, strandedVideoId, { timeoutMs: 30000 });

    assert(
      "a row stranded at 'converting' resumes via restart recovery and reaches 'ready'",
      strandedSettled.processing_status === "ready",
      `status=${strandedSettled.processing_status}`
    );
    const strandedDerivedExists = await storage.exists(strandedSettled.storage_key);
    assert("restart-recovered video: the derived object exists", strandedDerivedExists === true);
    assert(
      "restart-recovered video: original stranded source preserved via source_storage_key",
      strandedSettled.source_storage_key === strandedKey
    );

    // --- Unauthorized user cannot retry someone else's video ---
    const outsider = await registerUser(`${RUN_TAG}_outsider@test.cresamor.local`, "athlete");
    created.userIds.push(outsider.user.id);
    const unauthorizedRetry = await req(`/api/videos/${playableUpload.id}/retry-classification`, {
      method: "POST",
      token: outsider.token,
    });
    assert(
      "unrelated user cannot retry-classification another user's video",
      unauthorizedRetry.status === 403,
      `status=${unauthorizedRetry.status}`
    );
  } finally {
    try {
      for (const id of created.videoIds) {
        const videoRow = await client.query("SELECT storage_key, source_storage_key FROM videos WHERE id = $1", [id]);
        const row = videoRow.rows[0];
        if (row?.storage_key) {
          await storage.remove(row.storage_key).catch(() => {});
        }
        if (row?.source_storage_key && row.source_storage_key !== row?.storage_key) {
          await storage.remove(row.source_storage_key).catch(() => {});
        }
        await client.query("DELETE FROM clips WHERE video_id = $1", [id]);
        await client.query("DELETE FROM videos WHERE id = $1", [id]);
      }
      for (const id of created.userIds) {
        await client.query("DELETE FROM conversation_participants WHERE user_id = $1", [id]);
        await client.query("DELETE FROM security_audit_log WHERE user_id = $1", [id]);
        await client.query("DELETE FROM videos WHERE uploaded_by = $1", [id]);
        // Team Highlights, Slice 1: upload_attempts.user_id has no ON
        // DELETE behavior -- found by actually running this script
        // locally after Team Highlights landed (cleanup failed on
        // upload_attempts_user_id_fkey). Same fix as testAuth.js.
        await client.query("DELETE FROM upload_attempts WHERE user_id = $1", [id]);
        await client.query("DELETE FROM users WHERE id = $1", [id]);
      }
      await fs.promises.rm(fixtureDir, { recursive: true, force: true });
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
