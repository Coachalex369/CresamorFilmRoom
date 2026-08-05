/*
  videoConversion.js — Beta Stabilization Sprint. The FFmpeg mechanics for
  real MOV-to-MP4 conversion, kept separate from videoProcessing.js's
  orchestration/queue/lifecycle logic (small-modules precedent, same split
  as permissions.js/auditLog.js elsewhere in this project).

  Relies on the SYSTEM ffmpeg binary via PATH — Render's Native Runtime
  ships with FFmpeg preinstalled, and the common npm workaround
  (ffmpeg-static, a bundled static binary) has a documented segfault issue
  specifically on Render. No new dependency, no deploy config change.

  Everything streams to/from disk — never buffers a whole video in memory,
  matching the upload path's existing discipline (see storage/r2Storage.js).
*/

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const storage = require("./storage/storage");

const TEMP_ROOT = path.join(__dirname, "../../uploads/.tmp");

// Tail-only — a full ffmpeg stderr log can be enormous and isn't useful as
// a stored, non-secret error message; the last couple thousand characters
// almost always contain the actual failure reason.
const STDERR_TAIL_LIMIT = 2000;

// Conversion recovery redesign: without an upper bound, a genuinely hung
// ffmpeg process (not crashed, not exited — just stuck) would leave
// convertOne()'s await unresolved forever, which keeps conversionBusy
// true forever and silently blocks every future conversion behind it —
// recovered, manually retried, or a brand-new upload — not just the one
// that hung. Env-driven like this project's other operational limits
// (MAX_VIDEO_UPLOAD_MB, ALLOWED_ORIGIN).
const CONVERSION_TIMEOUT_MS = Number(process.env.VIDEO_CONVERSION_TIMEOUT_MS) || 10 * 60 * 1000;

// Real production incident: converting a mere 10MB/7.5s phone clip with NO
// explicit thread count OOM'd the 512MB instance. Measured locally with
// the exact production command against that real file: libx264
// auto-detected this machine's core count (threads=18, lookahead_threads=6)
// and peaked at ~694MB RSS — file size was never the driver, thread count
// was. Docker/cgroup containers commonly report the HOST's full core
// count via nproc even when only a fraction of a CPU is actually
// allocated (Render's instance here is 0.5 vCPU), so "auto" thread
// detection is unsafe in this environment regardless of input size.
// Re-measured the SAME file with threads pinned to 1 (both the top-level
// ffmpeg option and explicitly via -x264-params, so there's no ambiguity
// about which stage picks it up): peak RSS dropped to ~310MB — comfortably
// under budget with headroom for Node + OS. Env-driven, same convention as
// every other operational limit in this project.
const FFMPEG_THREADS = Number(process.env.VIDEO_FFMPEG_THREADS) || 1;

// Preflight bounds (see runPreflightProbe below) — conservative, phone-
// footage-shaped defaults. A file exceeding these is rejected before
// FFmpeg ever runs, not discovered by watching memory climb.
const PREFLIGHT_MAX_WIDTH = Number(process.env.VIDEO_PREFLIGHT_MAX_WIDTH) || 3840;
const PREFLIGHT_MAX_HEIGHT = Number(process.env.VIDEO_PREFLIGHT_MAX_HEIGHT) || 2160;
const PREFLIGHT_MAX_FPS = Number(process.env.VIDEO_PREFLIGHT_MAX_FPS) || 60;

// Best-effort peak-RSS sample for one process — Linux only (Render's
// runtime; local Windows dev silently gets null, never breaks anything).
// /proc/<pid>/status's VmHWM field IS the kernel-tracked high-water mark
// already, monotonically increasing for the process's whole life, so
// polling periodically and keeping the last successful read is
// sufficient — no need to compute a running max ourselves.
function samplePeakRssMb(pid) {
  if (process.platform !== "linux") return null;
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const match = status.match(/VmHWM:\s+(\d+)\s+kB/);
    return match ? Math.round(Number(match[1]) / 1024) : null;
  } catch {
    // Process already exited, /proc entry gone, or not permitted —
    // any of these just means "no sample this tick," not an error.
    return null;
  }
}

// Low-level bounded-ffmpeg-process runner, extracted so videoRemux.js can
// reuse the exact same timeout/SIGKILL/RSS-sampling/stderr-tail safety net
// for its much simpler stream-copy args, instead of duplicating this
// machinery for a second, less-tested code path. Takes the full argv
// (everything after "ffmpeg"), resolves { peakRssMb } on a zero exit code.
function runFfmpegProcess(args) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", args);

    let stderrTail = "";
    let peakRssMb = null;
    // Guards against the timeout and a real process event (error/close)
    // both trying to resolve/reject this promise — same "first one wins"
    // shape as the client-side upload stall timer in recordingPipeline.js.
    let settled = false;

    const rssTimer = setInterval(() => {
      const sample = samplePeakRssMb(ffmpeg.pid);
      if (sample !== null) peakRssMb = sample;
    }, 500);

    const timeoutTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearInterval(rssTimer);

      ffmpeg.kill("SIGKILL");
      const error = new Error(`Conversion timed out after ${Math.round(CONVERSION_TIMEOUT_MS / 1000)}s`);
      error.peakRssMb = peakRssMb;
      reject(error);
    }, CONVERSION_TIMEOUT_MS);

    ffmpeg.stderr.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_LIMIT);
    });

    ffmpeg.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearInterval(rssTimer);

      // Covers "ffmpeg not found" (ENOENT) as well as other spawn failures.
      reject(new Error(`Failed to start ffmpeg: ${error.message}`));
    });

    ffmpeg.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearInterval(rssTimer);

      if (code === 0) {
        resolve({ peakRssMb });
      } else {
        const error = new Error(`ffmpeg exited with code ${code}: ${stderrTail || "(no stderr output)"}`);
        error.peakRssMb = peakRssMb;
        reject(error);
      }
    });
  });
}

// Full transcode args — thin wrapper over runFfmpegProcess() preserving
// this function's original signature/behavior for convertVideo() below.
//
// Explicit -map (added after the OOM incident, alongside -threads):
// without it, ffmpeg's automatic stream selection is a heuristic, not a
// contract — it happened to drop this project's first real-world
// Cinematic-mode metadata streams correctly, but "happened to" is not a
// guarantee for whatever the next phone/camera puts in a container.
// Pinning to the first video and first (optional — the trailing "?"
// means "don't error if there's no audio track") audio stream makes the
// encode input deterministic across devices instead of trusting a
// heuristic that could change behavior on a future file. Resolves with
// { peakRssMb } (null if unmeasurable) so callers can log it — see
// convertVideo()'s conversion_attempt log line.
function runFfmpeg(inputPath, outputPath) {
  return runFfmpegProcess([
    "-i", inputPath,
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-threads", String(FFMPEG_THREADS),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-x264-params", `threads=${FFMPEG_THREADS}:lookahead_threads=${FFMPEG_THREADS}`,
    "-c:a", "aac",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-y",
    outputPath,
  ]);
}

function runFfprobe(inputPath) {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn("ffprobe", [
      "-v", "error",
      "-show_format",
      "-show_streams",
      "-print_format", "json",
      inputPath,
    ]);

    let stdout = "";
    let stderrTail = "";

    ffprobe.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    ffprobe.stderr.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_LIMIT);
    });

    ffprobe.on("error", (error) => {
      // Covers "ffprobe not found" (ENOENT) as well as other spawn failures.
      reject(new Error(`failed to start ffprobe: ${error.message}`));
    });

    ffprobe.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe exited with code ${code}: ${stderrTail || "(no stderr output)"}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (parseError) {
        reject(new Error(`failed to parse ffprobe output: ${parseError.message}`));
      }
    });
  });
}

// "30000/1001" -> 29.97, "0/0" (undefined rate) -> null.
function parseFrameRate(rate) {
  if (!rate) return null;
  const [num, den] = rate.split("/").map(Number);
  if (!den) return null;
  return num / den;
}

// Runs BEFORE ffmpeg ever starts — the whole point is to reject a
// pathological or unexpectedly demanding file based on cheap metadata
// (probing reads the container's header/index, not the full video) rather
// than discovering the problem by watching memory climb during a real
// encode. A probe failure (corrupt file, exotic/unreadable container) and
// a resolution/frame-rate that exceeds the conservative bounds above are
// both treated the same way here — as a rejection — so callers don't need
// to distinguish "couldn't tell what this is" from "know exactly what
// this is and it's too demanding for this instance."
async function runPreflightProbe(inputPath) {
  const probe = await runFfprobe(inputPath);
  const videoStream = (probe.streams || []).find((stream) => stream.codec_type === "video");

  if (!videoStream) {
    throw new Error("no video stream found in probe output");
  }

  const { width, height, codec_name: codec } = videoStream;
  const fps = parseFrameRate(videoStream.r_frame_rate) || parseFrameRate(videoStream.avg_frame_rate);
  const durationSeconds = Number(probe.format?.duration) || null;
  const details = `codec=${codec} ${width}x${height} fps=${fps ? fps.toFixed(2) : "unknown"} duration=${durationSeconds ?? "unknown"}s`;

  if (!width || !height) {
    throw new Error(`missing video dimensions in probe output — ${details}`);
  }

  if (width > PREFLIGHT_MAX_WIDTH || height > PREFLIGHT_MAX_HEIGHT) {
    throw new Error(
      `resolution ${width}x${height} exceeds max ${PREFLIGHT_MAX_WIDTH}x${PREFLIGHT_MAX_HEIGHT} — ${details}`
    );
  }

  if (fps && fps > PREFLIGHT_MAX_FPS) {
    throw new Error(`frame rate ${fps.toFixed(2)} exceeds max ${PREFLIGHT_MAX_FPS} — ${details}`);
  }

  return { width, height, fps, codec, durationSeconds };
}

// video: the full videos row (needs id, storage_key, team_id, created_at).
// Returns { newKey } on success. Throws on any failure — callers are
// responsible for translating that into processing_status = 'failed'.
// Never touches the original object/row; that's the caller's job, only
// after this resolves.
async function convertVideo(video) {
  const tempDir = path.join(TEMP_ROOT, `convert-${crypto.randomUUID()}`);
  await fs.promises.mkdir(tempDir, { recursive: true });

  const startedAt = Date.now();
  let probeResult = null;
  let peakRssMb = null;

  // Roadmap logging (not yet a DB column, just structured console output —
  // see the OOM incident this whole file was rewritten for): one line per
  // attempt, success or failure, with enough to spot patterns as beta
  // uploads get more varied — was this a resolution/fps/codec this
  // instance struggles with, how long did it take, how much memory did it
  // actually use. Logged from a single place (both call sites below)
  // rather than duplicated at every throw site.
  function logConversionAttempt(outcome, error) {
    console.log(
      JSON.stringify({
        event: "video_conversion_attempt",
        videoId: video.id,
        outcome,
        durationMs: Date.now() - startedAt,
        peakRssMb,
        probe: probeResult,
        error: error ? error.message : null,
      })
    );
  }

  try {
    const sourceExtension = path.extname(video.storage_key) || ".mov";
    const inputPath = path.join(tempDir, `input${sourceExtension}`);
    const outputPath = path.join(tempDir, "output.mp4");

    await storage.downloadToFile(video.storage_key, inputPath);

    // Failure stage is baked into the thrown message itself — callers
    // (convertOne() in videoProcessing.js) already funnel any thrown
    // error from this function straight into processing_error verbatim,
    // so prefixing here is what actually gets a coach/operator "this
    // failed during preflight, here's what was probed" instead of a bare
    // ffprobe/ffmpeg error with no context about which stage it came from.
    try {
      probeResult = await runPreflightProbe(inputPath);
    } catch (preflightError) {
      throw new Error(`Preflight probe rejected the file: ${preflightError.message}`);
    }

    let ffmpegResult;
    try {
      ffmpegResult = await runFfmpeg(inputPath, outputPath);
    } catch (ffmpegError) {
      peakRssMb = ffmpegError.peakRssMb ?? null;
      throw ffmpegError;
    }
    peakRssMb = ffmpegResult.peakRssMb;

    const teamSegment = video.team_id || "unassigned";
    const year = new Date(video.created_at).getFullYear();
    const extension = storage.extensionFor("video", "video/mp4");
    const newKey = `videos/${teamSegment}/${year}/${crypto.randomUUID()}${extension}`;

    await storage.upload(newKey, outputPath, "video/mp4", { category: "video" });

    const verified = await storage.exists(newKey);
    if (!verified) {
      throw new Error("Converted object failed existence verification after upload");
    }

    logConversionAttempt("success");
    return { newKey };
  } catch (error) {
    logConversionAttempt("failed", error);
    throw error;
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch((error) => {
      console.error("Failed to clean up conversion temp directory:", tempDir, error);
    });
  }
}

module.exports = {
  convertVideo,
  // Exported for videoRemux.js — the same bounded spawn/timeout/SIGKILL/
  // RSS-sampling safety net, reused with a much simpler stream-copy argv
  // instead of duplicating that machinery for a second code path.
  runFfmpegProcess,
  // Exported for videoClassification.js — same ffprobe-invocation logic,
  // no reason to duplicate it. runFfprobe's positional arg is passed
  // straight to ffprobe's CLI, which accepts an http(s) URL exactly like a
  // local path (protocol auto-detected), so classification can probe a
  // signed R2 URL directly without downloading.
  runFfprobe,
};
