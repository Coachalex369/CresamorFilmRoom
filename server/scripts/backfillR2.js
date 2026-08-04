/*
  backfillR2.js — Beta Readiness Sprint 1, optional one-time rescue script.

  NOT wired into npm start/dev, never auto-run. Run by hand:
    node server/scripts/backfillR2.js
  after STORAGE_PROVIDER=r2 and the R2 env vars are set (locally against a
  real bucket, or in Render's environment before running this against
  production).

  What it does: finds videos/users rows that still have a legacy local
  file_url/profile_picture_url and no storage_key/profile_picture_key,
  checks whether the file is STILL actually present on this disk right
  now, and if so uploads it to R2 and sets the key column. Rows whose
  files are already gone (this has already happened once to this project
  — see ARCHITECTURE.md's storage section) are logged and skipped, not
  treated as an error. Never deletes the local file, never clears
  file_url/profile_picture_url — a row that gets a storage_key is a rows
  that now has BOTH, harmlessly (storage_key takes routing priority, see
  withPlaybackStatus/withResolvedPhotoUrl in the route files).
*/

const path = require("path");
const fs = require("fs");

const client = require("../db/client");
const storage = require("../services/storage/storage");

if (process.env.STORAGE_PROVIDER !== "r2") {
  console.error(
    "STORAGE_PROVIDER is not 'r2' — set it (and the R2_* env vars) before running this script, or there's nowhere to back the files up to."
  );
  process.exit(1);
}

function localPathFor(urlPath) {
  return path.join(__dirname, "../..", urlPath);
}

// storage.upload() removes its source file on success — correct for the
// live upload routes (a real temp file nobody else needs), wrong here:
// backfilling must never delete the original local file. Copy it to a
// scratch path first and upload the COPY, leaving the original in place
// no matter what happens.
const backfillTempDir = path.join(__dirname, "../../uploads/.tmp");

async function uploadWithoutDeletingSource(key, sourcePath, contentType) {
  if (!fs.existsSync(backfillTempDir)) {
    fs.mkdirSync(backfillTempDir, { recursive: true });
  }

  const scratchPath = path.join(backfillTempDir, `backfill-${Date.now()}-${path.basename(sourcePath)}`);
  fs.copyFileSync(sourcePath, scratchPath);
  await storage.upload(key, scratchPath, contentType);
}

async function backfillVideos() {
  const { rows } = await client.query(
    `SELECT id, file_url FROM videos WHERE storage_key IS NULL AND file_url IS NOT NULL AND file_url NOT LIKE 'http%'`
  );

  let uploaded = 0;
  let missing = 0;
  let failed = 0;

  for (const video of rows) {
    const localPath = localPathFor(video.file_url);

    if (!fs.existsSync(localPath)) {
      missing += 1;
      continue;
    }

    try {
      const key = `videos/backfill-${video.id}-${path.basename(video.file_url)}`;
      await uploadWithoutDeletingSource(key, localPath, "video/mp4");
      await client.query("UPDATE videos SET storage_key = $1 WHERE id = $2", [key, video.id]);
      uploaded += 1;
    } catch (error) {
      console.error(`Failed to backfill video ${video.id}:`, error.message);
      failed += 1;
    }
  }

  return { total: rows.length, uploaded, missing, failed };
}

async function backfillProfilePictures() {
  const { rows } = await client.query(
    `SELECT id, profile_picture_url FROM users WHERE profile_picture_key IS NULL AND profile_picture_url IS NOT NULL AND profile_picture_url NOT LIKE 'http%'`
  );

  let uploaded = 0;
  let missing = 0;
  let failed = 0;

  for (const user of rows) {
    const localPath = localPathFor(user.profile_picture_url);

    if (!fs.existsSync(localPath)) {
      missing += 1;
      continue;
    }

    try {
      const key = `profile-pictures/backfill-${user.id}-${path.basename(user.profile_picture_url)}`;
      await uploadWithoutDeletingSource(key, localPath, "image/jpeg");
      await client.query("UPDATE users SET profile_picture_key = $1 WHERE id = $2", [key, user.id]);
      uploaded += 1;
    } catch (error) {
      console.error(`Failed to backfill profile picture for user ${user.id}:`, error.message);
      failed += 1;
    }
  }

  return { total: rows.length, uploaded, missing, failed };
}

async function main() {
  console.log("Backfilling videos...");
  const videoResult = await backfillVideos();
  console.log(
    `Videos — found: ${videoResult.total}, uploaded: ${videoResult.uploaded}, already missing: ${videoResult.missing}, failed: ${videoResult.failed}`
  );

  console.log("Backfilling profile pictures...");
  const photoResult = await backfillProfilePictures();
  console.log(
    `Profile pictures — found: ${photoResult.total}, uploaded: ${photoResult.uploaded}, already missing: ${photoResult.missing}, failed: ${photoResult.failed}`
  );

  await client.end();
}

main().catch((error) => {
  console.error("Backfill script failed:", error);
  process.exit(1);
});
