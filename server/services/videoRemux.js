/*
  videoRemux.js — Play-First Video Pipeline. Low-memory stream-copy remux
  for the "codecs are fine, container isn't" case (classifyVideo() ==
  'remux') — structurally parallel to videoConversion.js's convertVideo()
  but far simpler: no encoder, no frame buffers, just demux/mux, so it's
  safe to run in-process on Render's web dyno (unlike a full transcode).

  Verified against a real 654MB production file (video 274): remuxing
  QuickTime-wrapped H.264/AAC to MP4 via -c copy took 1.88s at 223x
  realtime, no re-encoding. Same bounded spawn/timeout/SIGKILL safety net
  as convertVideo() regardless — no reason to trust an unbounded process
  just because it's usually fast.
*/

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const storage = require("./storage/storage");
const { runFfmpegProcess } = require("./videoConversion");

const TEMP_ROOT = path.join(__dirname, "../../uploads/.tmp");

// video: the full videos row (needs id, storage_key, team_id, created_at).
// Returns { newKey } on success. Throws on any failure — callers translate
// that into processing_status = 'failed', same contract as convertVideo().
// Original object is never touched here; caller preserves it via
// source_storage_key, after this resolves.
async function remuxVideo(video) {
  const tempDir = path.join(TEMP_ROOT, `remux-${crypto.randomUUID()}`);
  await fs.promises.mkdir(tempDir, { recursive: true });

  try {
    const outputPath = path.join(tempDir, "output.mp4");

    // Prefers reading directly from the signed R2 URL as ffmpeg's input —
    // avoids a local download entirely, since a stream-copy remux only
    // needs to read/write packets, never a full frame buffer. Whether this
    // Render build's ffmpeg has HTTPS input support isn't guaranteed, so a
    // failure here (not the general "-i" pathological case, just this
    // specific attempt) falls back to downloadToFile(), same as
    // convertVideo()'s always-local-file approach.
    const signedUrl = await storage.getSignedUrl(video.storage_key);
    const remuxArgs = (input) => [
      "-i", input,
      "-map", "0:v:0",
      "-map", "0:a:0?",
      "-c", "copy",
      "-movflags", "+faststart",
      "-y",
      outputPath,
    ];

    try {
      await runFfmpegProcess(remuxArgs(signedUrl));
    } catch (streamError) {
      console.warn(
        `remuxVideo: streaming input failed for video ${video.id}, falling back to local download:`,
        streamError.message
      );
      const sourceExtension = path.extname(video.storage_key) || ".mov";
      const inputPath = path.join(tempDir, `input${sourceExtension}`);
      await storage.downloadToFile(video.storage_key, inputPath);
      await runFfmpegProcess(remuxArgs(inputPath));
    }

    const teamSegment = video.team_id || "unassigned";
    const year = new Date(video.created_at).getFullYear();
    const extension = storage.extensionFor("video", "video/mp4");
    const newKey = `videos/${teamSegment}/${year}/${crypto.randomUUID()}${extension}`;

    await storage.upload(newKey, outputPath, "video/mp4", { category: "video" });

    const verified = await storage.exists(newKey);
    if (!verified) {
      throw new Error("Remuxed object failed existence verification after upload");
    }

    return { newKey };
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch((error) => {
      console.error("Failed to clean up remux temp directory:", tempDir, error);
    });
  }
}

module.exports = { remuxVideo };
