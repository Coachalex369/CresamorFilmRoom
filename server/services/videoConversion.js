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

function runFfmpeg(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-i", inputPath,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-c:a", "aac",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-y",
      outputPath,
    ]);

    let stderrTail = "";

    ffmpeg.stderr.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_LIMIT);
    });

    ffmpeg.on("error", (error) => {
      // Covers "ffmpeg not found" (ENOENT) as well as other spawn failures.
      reject(new Error(`Failed to start ffmpeg: ${error.message}`));
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderrTail || "(no stderr output)"}`));
      }
    });
  });
}

// video: the full videos row (needs id, storage_key, team_id, created_at).
// Returns { newKey } on success. Throws on any failure — callers are
// responsible for translating that into processing_status = 'failed'.
// Never touches the original object/row; that's the caller's job, only
// after this resolves.
async function convertVideo(video) {
  const tempDir = path.join(TEMP_ROOT, `convert-${crypto.randomUUID()}`);
  await fs.promises.mkdir(tempDir, { recursive: true });

  try {
    const sourceExtension = path.extname(video.storage_key) || ".mov";
    const inputPath = path.join(tempDir, `input${sourceExtension}`);
    const outputPath = path.join(tempDir, "output.mp4");

    await storage.downloadToFile(video.storage_key, inputPath);
    await runFfmpeg(inputPath, outputPath);

    const teamSegment = video.team_id || "unassigned";
    const year = new Date(video.created_at).getFullYear();
    const extension = storage.extensionFor("video", "video/mp4");
    const newKey = `videos/${teamSegment}/${year}/${crypto.randomUUID()}${extension}`;

    await storage.upload(newKey, outputPath, "video/mp4", { category: "video" });

    const verified = await storage.exists(newKey);
    if (!verified) {
      throw new Error("Converted object failed existence verification after upload");
    }

    return { newKey };
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch((error) => {
      console.error("Failed to clean up conversion temp directory:", tempDir, error);
    });
  }
}

module.exports = { convertVideo };
