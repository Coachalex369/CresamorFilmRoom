/*
  videoProcessing.js — video processing pipeline.

  Beta Stabilization Sprint: real MOV-to-MP4 conversion replaces the
  Foundation Sprint Phase 3 placeholder that used to flip
  processing_status to 'processing' and just... stop there forever (see
  git history for the old fake 1.5s-delay version). The lifecycle is now
  real and user-visible:

    uploading -> [queued -> converting -> ready] (needs conversion)
    uploading -> ready                            (doesn't need conversion)
    ... -> failed        (a genuine conversion error)
    uploading -> deferred (needs conversion but exceeds the beta
                            automatic-eligibility size cap — NOT an error,
                            see MAX_AUTO_CONVERSION_SIZE_BYTES; decided by
                            the upload route itself, before this module
                            is ever involved, since only the route knows
                            the uploaded file's size)

  Conversion mechanics (ffmpeg spawn, download/upload, temp file
  lifecycle) live in videoConversion.js — this file owns orchestration
  only: the single-flight in-process queue, DB status transitions, and
  the manual-retry / boot-time-requeue entry points.
*/

const client = require("../db/client");
const videoConversion = require("./videoConversion");
const storage = require("./storage/storage");

// Beta limit, not a hard technical ceiling — a very large source file on
// Render's 0.5 shared-vCPU Starter instance could tie up the single-item
// conversion queue for a very long time, delaying every other coach's
// conversion behind it. Files over this size still upload and stay
// playable-once-converted-later; they just don't enter the automatic
// queue. A manual retry (see retryConversion below) always attempts
// conversion regardless of size — this cap only gates the automatic path.
const MAX_AUTO_CONVERSION_SIZE_BYTES = 600 * 1024 * 1024;

// Playback-fix pass: browsers (especially non-Safari) don't reliably play
// .MOV directly. R2 migration fix: storage_key rows leave file_url NULL
// (see ARCHITECTURE.md's "Storage strategy"), so this has to check
// storage_key first — checking file_url alone silently never detected
// .MOV on any R2-routed upload, a real bug caught while implementing the
// opaque-key refinement.
function needsFormatConversion(video) {
  const source = video.storage_key || video.file_url || "";
  return /\.mov(\?.*)?$/i.test(source);
}

let conversionBusy = false;
const conversionQueue = [];

// The busy flag is set synchronously, before any await — the exact fix
// just applied client-side to recordingPipeline.js's identical race
// (check-then-set across an await boundary let concurrent calls both
// slip through and start processing the same item). Applying the correct
// pattern here from the start means this bug class never gets introduced
// server-side in the first place.
function enqueueConversion(videoId) {
  conversionQueue.push(videoId);
  processConversionQueue();
}

async function processConversionQueue() {
  if (conversionBusy) return;
  conversionBusy = true;

  try {
    while (conversionQueue.length) {
      const videoId = conversionQueue.shift();
      await convertOne(videoId);
    }
  } finally {
    conversionBusy = false;
  }
}

async function convertOne(videoId) {
  try {
    const result = await client.query("SELECT * FROM videos WHERE id = $1", [videoId]);
    const video = result.rows[0];

    // Defensive — shouldn't happen in normal operation (only
    // conversion-needing videos ever get queued), but a deleted-mid-queue
    // or already-converted row must not crash the queue drain.
    if (!video || !needsFormatConversion(video)) return;

    await client.query("UPDATE videos SET processing_status = 'converting' WHERE id = $1", [videoId]);

    const { newKey } = await videoConversion.convertVideo(video);

    await client.query(
      `
      UPDATE videos
      SET storage_key = $1, source_storage_key = $2, processing_status = 'ready', processing_error = NULL
      WHERE id = $3
      `,
      [newKey, video.storage_key, videoId]
    );
  } catch (error) {
    console.error("Video conversion failed:", videoId, error);

    const message = String(error?.message || error).slice(0, 500);

    try {
      await client.query(
        `UPDATE videos SET processing_status = 'failed', processing_error = $1 WHERE id = $2`,
        [message, videoId]
      );
    } catch (updateError) {
      console.error("Failed to mark video conversion as failed:", videoId, updateError);
    }
  }
}

// Entry point from the upload route. Videos that exceed
// MAX_AUTO_CONVERSION_SIZE_BYTES never reach this function at all — the
// route decides 'deferred' itself, since only it knows the uploaded
// file's size (multer's req.file.size) without an extra round-trip.
async function enqueueVideoProcessing(video) {
  if (!needsFormatConversion(video)) {
    const result = await client.query(
      `UPDATE videos SET processing_status = 'ready' WHERE id = $1 RETURNING *`,
      [video.id]
    );
    return result.rows[0];
  }

  const result = await client.query(
    `UPDATE videos SET processing_status = 'queued' WHERE id = $1 RETURNING *`,
    [video.id]
  );

  enqueueConversion(video.id);

  return result.rows[0];
}

// Fire-and-forget wrapper for the upload route: the HTTP response must not
// wait on this, and a failure here must not become an unhandled promise
// rejection. Only covers failures in the initial status transition itself
// (e.g. a DB error) — the actual conversion's own failures are caught and
// recorded independently inside convertOne, since that runs later,
// decoupled from this call.
async function enqueueVideoProcessingAsync(video) {
  try {
    await enqueueVideoProcessing(video);
  } catch (error) {
    console.error("Video processing failed:", error);

    try {
      await client.query(
        `UPDATE videos SET processing_status = 'failed', processing_error = $1 WHERE id = $2`,
        [String(error?.message || error).slice(0, 500), video.id]
      );
    } catch (updateError) {
      console.error("Failed to mark video as failed:", updateError);
    }
  }
}

// Called from the retry-conversion route. Always attempts conversion
// regardless of size — the automatic cap is a one-time upload-time
// decision, not something a deliberate manual retry should be blocked by.
async function retryConversion(videoId) {
  await client.query(
    `UPDATE videos SET processing_status = 'queued', processing_error = NULL WHERE id = $1`,
    [videoId]
  );
  enqueueConversion(videoId);
}

// Called once at server startup, from inside app.listen()'s success
// callback (see server.js) — by the time this runs, the HTTP server is
// already accepting requests, so nothing here can ever delay or block
// that. Fire-and-forget from the caller's side; every failure path below
// is caught locally so this can never become an unhandled rejection.
//
// The in-process queue (conversionQueue/conversionBusy) is empty by
// definition on a fresh boot — nothing has been enqueued yet — so any row
// already sitting at 'converting' at this exact moment cannot be work
// this process is doing; it's unconditionally orphaned from a prior
// process life (a Render redeploy or crash mid-conversion, most likely).
// Deliberately narrower than the old requeueStuckConversions(): only
// 'converting' is recovered, never 'deferred' (that's not stranded, it's
// a deliberate non-error resting state).
//
// Production incident this replaces: the old version blindly re-queued
// and immediately re-attempted conversion regardless of file size,
// which is exactly what exhausted the 0.5vCPU/512MB instance and caused
// sustained 502s across every route. This version re-checks size before
// resuming anything — source_size_bytes when available (free, no I/O);
// a live R2 HeadObject size check as a fallback for legacy rows that
// predate that column. A row whose size can't be determined at all
// (HEAD itself fails) is treated as unsafe to auto-resume and marked
// 'failed' with a concise processing_error, rather than either silently
// skipping it forever or blindly resuming it.
async function recoverStrandedConversions() {
  let stranded;
  try {
    stranded = await client.query(
      `SELECT id, storage_key, source_size_bytes FROM videos WHERE processing_status = 'converting'`
    );
  } catch (error) {
    console.error("Startup conversion recovery: failed to query stranded videos:", error);
    return;
  }

  let resumed = 0;
  let deferred = 0;
  let failed = 0;

  for (const row of stranded.rows) {
    try {
      let sizeBytes = row.source_size_bytes;

      if (sizeBytes === null || sizeBytes === undefined) {
        sizeBytes = await storage.getObjectSize(row.storage_key);
      }

      if (sizeBytes > MAX_AUTO_CONVERSION_SIZE_BYTES) {
        await client.query(`UPDATE videos SET processing_status = 'deferred' WHERE id = $1`, [
          row.id,
        ]);
        deferred++;
        continue;
      }

      await client.query(
        `UPDATE videos SET processing_status = 'queued', processing_error = NULL WHERE id = $1`,
        [row.id]
      );
      enqueueConversion(row.id);
      resumed++;
    } catch (error) {
      console.error("Startup conversion recovery: could not resolve size for video", row.id, error);

      try {
        await client.query(
          `UPDATE videos SET processing_status = 'failed', processing_error = $1 WHERE id = $2`,
          [`Startup recovery: could not verify file size (${String(error?.message || error).slice(0, 400)})`, row.id]
        );
      } catch (updateError) {
        console.error("Startup conversion recovery: failed to mark video as failed:", row.id, updateError);
      }
      failed++;
    }
  }

  console.log(
    `Startup conversion recovery: found ${stranded.rows.length} orphaned conversion(s) in 'converting'; ` +
      `resumed ${resumed}, deferred ${deferred} (oversized), failed ${failed} (size unverifiable).`
  );
}

module.exports = {
  enqueueVideoProcessing,
  enqueueVideoProcessingAsync,
  needsFormatConversion,
  retryConversion,
  recoverStrandedConversions,
  MAX_AUTO_CONVERSION_SIZE_BYTES,
};
