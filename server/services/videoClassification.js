/*
  videoClassification.js — Play-First Video Pipeline. Replaces the old
  needsFormatConversion()'s crude ".mov extension = needs work" heuristic
  with real codec/container inspection, so routing decisions are based on
  what a browser can actually play, not on file size or extension.

  Probes the signed R2 URL directly via ffprobe (reusing videoConversion.js's
  runFfprobe/parseFrameRate) rather than downloading the object first —
  ffprobe reads container/stream headers over HTTP range requests, so this
  never pulls the whole file down just to classify it. This is what makes
  classification safe to run on every upload regardless of size, unlike the
  old download-then-transcode path.

  Verified against a real 654MB production file (video 274,
  Lex-State-Wrestling.MOV): H.264 High Profile + AAC-LC in a QuickTime
  container — codecs already browser-native, only the container (plus
  stray Apple mebx metadata tracks) was the problem. Classified as 'remux'.
*/

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const storage = require("./storage/storage");
const { runFfprobe } = require("./videoConversion");

const TEMP_ROOT = path.join(__dirname, "../../uploads/.tmp");

const DIRECTLY_PLAYABLE_VIDEO_CODECS = new Set(["h264", "vp9"]);
const DIRECTLY_PLAYABLE_AUDIO_CODECS = new Set(["aac", "opus"]);
const DIRECTLY_PLAYABLE_CONTAINERS = new Set(["mov,mp4,m4a,3gp,3g2,mj2", "matroska,webm"]);

const REMUX_ELIGIBLE_VIDEO_CODECS = new Set(["h264"]);
const REMUX_ELIGIBLE_AUDIO_CODECS = new Set(["aac"]);

// ffprobe's format_name for an actual .mp4/.m4a container is the same
// comma-joined string as .mov ("mov,mp4,m4a,3gp,3g2,mj2" — they're the
// same underlying ISO-BMFF family) — so "directly playable" vs "remux"
// can't be told apart by format_name alone; it has to come from the
// video's actual storage_key/file_url extension, same signal
// needsFormatConversion() used to key off of.
function containerFromSource(video) {
  const source = video.storage_key || video.file_url || "";
  const match = source.match(/\.([a-z0-9]+)(?:\?.*)?$/i);
  return match ? match[1].toLowerCase() : null;
}

// Prefers probing the signed URL directly (no download — see file header).
// Falls back to a local download if that fails, which also transparently
// covers the local-disk storage provider (dev/test environments):
// storage.getSignedUrl() there returns a bare "/uploads/..." path, not a
// fetchable URL, so ffprobe can't read it directly — the same fallback
// that handles an R2 streaming hiccup in production handles that case too.
async function probeSource(video) {
  const signedUrl = await storage.getSignedUrl(video.storage_key);

  try {
    return await runFfprobe(signedUrl);
  } catch (streamError) {
    console.warn(
      `classifyVideo: streaming probe failed for video ${video.id}, falling back to local download:`,
      streamError.message
    );

    const tempDir = path.join(TEMP_ROOT, `classify-${crypto.randomUUID()}`);
    await fs.promises.mkdir(tempDir, { recursive: true });
    try {
      const sourceExtension = path.extname(video.storage_key) || ".mov";
      const inputPath = path.join(tempDir, `input${sourceExtension}`);
      await storage.downloadToFile(video.storage_key, inputPath);
      return await runFfprobe(inputPath);
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch((error) => {
        console.error("Failed to clean up classification temp directory:", tempDir, error);
      });
    }
  }
}

// video: the full videos row (needs id, storage_key). Returns
// { classification, video_codec, audio_codec, container }. Never throws —
// a probe failure is itself a classification result (conservative default:
// 'transcode_needed', never silently assume playable on a read failure).
async function classifyVideo(video) {
  const container = containerFromSource(video);

  let probe;
  try {
    probe = await probeSource(video);
  } catch (error) {
    console.error(`classifyVideo: probe failed for video ${video.id}:`, error.message);
    return { classification: "transcode_needed", video_codec: null, audio_codec: null, container };
  }

  const videoStream = (probe.streams || []).find((stream) => stream.codec_type === "video");
  const audioStream = (probe.streams || []).find((stream) => stream.codec_type === "audio");

  if (!videoStream) {
    return { classification: "transcode_needed", video_codec: null, audio_codec: null, container };
  }

  const videoCodec = videoStream.codec_name || null;
  const audioCodec = audioStream ? audioStream.codec_name || null : null;
  const formatName = probe.format?.format_name || null;

  const isMp4Container = container === "mp4" || container === "m4v";
  const isWebmContainer = container === "webm";
  const audioOk = audioCodec === null || DIRECTLY_PLAYABLE_AUDIO_CODECS.has(audioCodec);

  if (
    formatName &&
    DIRECTLY_PLAYABLE_CONTAINERS.has(formatName) &&
    (isMp4Container || isWebmContainer) &&
    DIRECTLY_PLAYABLE_VIDEO_CODECS.has(videoCodec) &&
    audioOk
  ) {
    return { classification: "playable", video_codec: videoCodec, audio_codec: audioCodec, container };
  }

  const remuxAudioOk = audioCodec === null || REMUX_ELIGIBLE_AUDIO_CODECS.has(audioCodec);
  if (REMUX_ELIGIBLE_VIDEO_CODECS.has(videoCodec) && remuxAudioOk) {
    return { classification: "remux", video_codec: videoCodec, audio_codec: audioCodec, container };
  }

  return { classification: "transcode_needed", video_codec: videoCodec, audio_codec: audioCodec, container };
}

module.exports = { classifyVideo };
