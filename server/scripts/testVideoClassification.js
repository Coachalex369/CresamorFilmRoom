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

// Polls until processing_status leaves the transient classifying/remuxing
// states, or times out. Classification+remux is designed to resolve in
// low single-digit seconds (proven against a real 654MB production file:
// ~2s for a remux) — a generous 20s ceiling here leaves headroom without
// letting a genuine hang stall the whole test suite indefinitely.
async function waitForSettledStatus(token, videoId, { timeoutMs = 20000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data } = await req(`/api/videos/${videoId}`, { token });
    if (!["uploading", "classifying", "remuxing"].includes(data.processing_status)) {
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

    // --- Case 3: not a real video -> ffprobe fails -> 'transcode_needed' -> 'transcode_paused', NOT a dead end ---
    const bogusUpload = await uploadVideo(coach.token, {
      title: `${RUN_TAG}_bogus`,
      filePath: path.join(fixtureDir, "bogus.mp4"),
      mimeType: "video/mp4",
    });
    created.videoIds.push(bogusUpload.id);

    const bogusSettled = await waitForSettledStatus(coach.token, bogusUpload.id);
    assert(
      "unreadable file classifies as 'transcode_needed' and lands at transcode_paused",
      bogusSettled.processing_status === "transcode_paused" && bogusSettled.classification === "transcode_needed",
      `status=${bogusSettled.processing_status} classification=${bogusSettled.classification}`
    );
    assert(
      "transcode_paused case: playback_state is 'processing_paused', never a dead-end/error state",
      bogusSettled.playback_state === "processing_paused"
    );
    assert(
      "transcode_paused case: original object is still preserved and available",
      bogusSettled.available === true
    );

    // --- Retry-classification endpoint works for a transcode_paused row ---
    const retryRes = await req(`/api/videos/${bogusUpload.id}/retry-classification`, {
      method: "POST",
      token: coach.token,
    });
    assert("retry-classification succeeds for a transcode_paused video", retryRes.status === 200, `status=${retryRes.status}`);

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
