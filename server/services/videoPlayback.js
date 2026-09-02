/*
  videoPlayback.js — the playback-status/signed-URL resolution logic,
  extracted from videos.js (Team Highlights, Slice 1) so a second route
  (clips.js's owner-clips endpoint) can resolve the same authorized
  playback information for a clip's underlying source without relying on
  the Film-list response as an accidental source catalog. Behavior-
  preserving extraction — no logic changed, only moved.
*/

const fs = require("fs");
const path = require("path");
const storage = require("./storage/storage");

// Playback-fix pass: Render's /uploads disk is ephemeral and has already
// lost files across a redeploy once (see ARCHITECTURE.md's storage
// section). Rather than let the player discover that via a 404 mid-play,
// callers check file existence up front so the client can show a clear
// "unavailable" state instead of attempting playback. Only checked for
// local /uploads paths — external http(s) URLs are assumed reachable (no
// outbound request made here). This is the LEGACY path — rows from
// before the R2 migration, which never got a storage_key and keep using
// this exact logic indefinitely (see withPlaybackStatus below).
function isFileAvailable(fileUrl) {
  if (!fileUrl) return false;
  if (/^https?:\/\//i.test(fileUrl)) return true;

  const localPath = path.join(__dirname, "../..", fileUrl);
  return fs.existsSync(localPath);
}

// Play-First Pipeline: the single source of truth every client renders,
// replacing the old needs_conversion computed field. Maps the internal
// processing_status (which still includes legacy values like 'deferred'
// for historical rows not yet reclassified, and 'queued'/'converting' for
// the dormant full-transcode path) onto the small, honest vocabulary the
// UI actually shows — critically, there is no "too large" / unplayable
// terminal mapping anywhere in this table anymore.
const PLAYBACK_STATE_BY_PROCESSING_STATUS = {
  uploading: "uploading",
  classifying: "preparing_playback",
  remuxing: "preparing_playback",
  queued: "preparing_playback",
  converting: "preparing_playback",
  processing: "preparing_playback", // legacy/unused value, tolerated by the DB CHECK constraint
  ready: "playable",
  transcode_paused: "processing_paused",
  deferred: "processing_paused", // legacy — pre-migration rows not yet reclassified
  failed: "failed",
};

function playbackStateFor(video) {
  return PLAYBACK_STATE_BY_PROCESSING_STATUS[video.processing_status] || "preparing_playback";
}

// storage_key IS NOT NULL means this row goes through the storage
// abstraction (local disk or R2, whichever is active) — a signed/direct
// URL and a real existence check. NULL means a legacy row: unchanged
// file_url-based logic, forever, regardless of what STORAGE_PROVIDER is
// set to today. Deliberately independent of film_removed_at/upload_
// destination — a video's playability is a property of the row itself,
// not of whether it currently appears in the Film library list.
async function withPlaybackStatus(video) {
  if (video.storage_key) {
    return {
      ...video,
      file_url: await storage.getSignedUrl(video.storage_key),
      available: await storage.exists(video.storage_key),
      playback_state: playbackStateFor(video),
    };
  }

  return {
    ...video,
    available: isFileAvailable(video.file_url),
    playback_state: playbackStateFor(video),
  };
}

module.exports = {
  isFileAvailable,
  playbackStateFor,
  withPlaybackStatus,
  PLAYBACK_STATE_BY_PROCESSING_STATUS,
};
