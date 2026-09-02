/*
  localStorage.js — the "local disk" storage provider. Behavior-preserving
  extraction of what server/routes/videos.js and profile.js did inline
  before this abstraction existed — same uploads/ directory, same
  "missing file isn't an error" delete semantics. Default provider
  (STORAGE_PROVIDER unset or anything other than "r2") — local dev needs
  zero new setup.

  key is a relative path under uploads/, e.g. "videos/169...-clip.mp4" or
  "profile-pictures/169...-photo.jpg" — exactly what gets stored in
  videos.storage_key / users.profile_picture_key.
*/

const fs = require("fs");
const path = require("path");

const UPLOADS_ROOT = path.join(__dirname, "../../../uploads");

function resolvePath(key) {
  return path.join(UPLOADS_ROOT, key);
}

// filePath is always inside uploads/.tmp/ (same filesystem as the real
// destination), so a rename is a cheap move, not a copy. The fourth
// parameter (onProgress) is accepted for interface parity with
// r2Storage's upload() but deliberately never called — a single
// fs.rename() has no meaningful intermediate progress to report. A
// caller relying on progress-driven lease renewal simply gets none on
// local storage, which is a valid, harmless no-op, not a broken contract.
async function upload(key, filePath, contentType, { onProgress } = {}) {
  const destination = resolvePath(key);
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  await fs.promises.rename(filePath, destination);
}

async function getSignedUrl(key) {
  // No signing needed — Express already serves /uploads directly, and
  // always has. Matches file_url's existing shape exactly.
  return `/uploads/${key}`;
}

async function exists(key) {
  return fs.existsSync(resolvePath(key));
}

async function remove(key) {
  return new Promise((resolve) => {
    fs.unlink(resolvePath(key), (err) => {
      if (err && err.code !== "ENOENT") {
        console.error("Failed to delete local file:", resolvePath(key), err);
      }
      resolve();
    });
  });
}

// Team Highlights retention: mirrors r2Storage's removeVerified() —
// genuinely rejects on a real failure so the caller's state machine can
// decide to retry, rather than the best-effort remove() above's
// swallow-everything contract. ENOENT (already absent) resolves as
// success, matching the same "missing file isn't a failure" idempotent
// delete semantics used everywhere else in this abstraction.
async function removeVerified(key) {
  return new Promise((resolve, reject) => {
    fs.unlink(resolvePath(key), (err) => {
      if (err && err.code !== "ENOENT") {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

// A copy, not upload()'s move-semantics rename — the source (the real
// stored object) must stay in place for a download.
async function downloadToFile(key, destPath) {
  await fs.promises.copyFile(resolvePath(key), destPath);
}

// Mirrors r2Storage's getObjectSize() — throws (via fs.promises.stat's
// natural rejection) if the file is missing, same "let the caller decide
// what unknown-size means" contract.
async function getObjectSize(key) {
  const stats = await fs.promises.stat(resolvePath(key));
  return stats.size;
}

module.exports = { upload, getSignedUrl, exists, remove, removeVerified, downloadToFile, getObjectSize };
