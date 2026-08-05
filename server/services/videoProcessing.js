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
// Render's 0.5 shared-vCPU/512MB Starter instance can exhaust the
// instance outright (confirmed twice now: the original boot-time-requeue
// incident, and a manual retry of the same ~685MB file causing a real OOM
// outage). Files over this size still upload and stay
// playable-once-converted-later; they just don't enter the conversion
// queue by any path — automatic, startup recovery, or manual retry all
// respect this same cap on this instance size.
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

// Shared by retryConversion() and performStrandedConversionRecovery():
// source_size_bytes when the row already has it (free, no I/O); a live
// storage HeadObject/stat check as the fallback for legacy rows that
// predate that column. Throws if the size can't be determined at all —
// callers must treat "unknown size" as unsafe to launch FFmpeg for, never
// as "assume it's fine."
async function resolveSourceSizeBytes(video) {
  if (video.source_size_bytes !== null && video.source_size_bytes !== undefined) {
    return video.source_size_bytes;
  }
  return storage.getObjectSize(video.storage_key);
}

// Called from the retry-conversion route. Used to always attempt
// conversion regardless of size ("a manual retry always attempts
// conversion regardless of the automatic cap") — that was the direct
// cause of a real OOM outage (a manual retry of the ~685MB wrestling
// video exhausted this 512MB instance, the same failure mode as the
// original boot-time-requeue incident). A manual retry is now capped
// exactly like the automatic path and startup recovery: an oversized
// video is kept safely at 'deferred' rather than ever launching FFmpeg on
// this instance size. Returns an outcome object rather than assuming
// success, so the route can shape its HTTP response around what actually
// happened.
async function retryConversion(videoId) {
  const result = await client.query("SELECT * FROM videos WHERE id = $1", [videoId]);
  const video = result.rows[0];

  if (!video) {
    return { outcome: "not_found" };
  }

  let sizeBytes;
  try {
    sizeBytes = await resolveSourceSizeBytes(video);
  } catch (error) {
    const message = `Retry: could not verify file size (${String(error?.message || error).slice(0, 400)})`;
    await client.query(
      `UPDATE videos SET processing_status = 'failed', processing_error = $1 WHERE id = $2`,
      [message, videoId]
    );
    return { outcome: "size_unverifiable", processing_status: "failed", message };
  }

  if (sizeBytes > MAX_AUTO_CONVERSION_SIZE_BYTES) {
    await client.query(
      `UPDATE videos SET processing_status = 'deferred', processing_error = NULL WHERE id = $1`,
      [videoId]
    );
    return {
      outcome: "oversized",
      processing_status: "deferred",
      message: "This file exceeds the automatic conversion size limit on this instance — kept deferred, no conversion started.",
    };
  }

  await client.query(
    `UPDATE videos SET processing_status = 'queued', processing_error = NULL WHERE id = $1`,
    [videoId]
  );
  enqueueConversion(videoId);
  return { outcome: "queued", processing_status: "queued" };
}

// Safety guard added after a real incident: this project has one shared
// dev/prod database (DATABASE_URL is the same everywhere, see CLAUDE.md)
// — a stray local dev server, left running from earlier work and
// auto-restarted by nodemon on every file save, executed this exact
// function against the live production database using the LOCAL storage
// provider, and marked two real production videos 'failed' with a local
// filesystem path in the error, before the real Render deployment had
// even run. NODE_ENV + STORAGE_PROVIDER together are the only reliable
// signal that a given process actually IS the deployed R2-backed
// service, as opposed to a local process that merely happens to share its
// DATABASE_URL.
function isRecoveryEnvironmentSafe() {
  return process.env.NODE_ENV === "production" && process.env.STORAGE_PROVIDER === "r2";
}

// A 'queued' row (enqueued in-memory, not yet picked up) is just as
// orphanable by a restart as a 'converting' one — the in-memory
// conversionQueue is wiped either way. But unlike 'converting' (which is
// unconditionally safe to recover — nothing legitimate is ever
// 'converting' at the exact instant this process boots), a fresh upload
// on the NEW process can legitimately be 'queued' seconds after startup.
// Recovering every 'queued' row unconditionally would race a normal
// upload against this one-time startup pass. The grace period is the
// guard: only a 'queued' row old enough that it can't plausibly be from
// this process's own just-started life gets swept up.
const QUEUED_RECOVERY_GRACE_PERIOD_MS = 90 * 1000;

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
// 'queued' rows are recovered too (see QUEUED_RECOVERY_GRACE_PERIOD_MS
// above and resolveQueuedRecoveryCandidates below) but only past the
// grace period, to avoid racing a genuinely fresh upload. Neither case
// ever touches 'deferred' — that's not stranded, it's a deliberate
// non-error resting state.
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
// candidateIds is a test-only scoping parameter (see
// testConversionRecovery.js) — production's real call site (server.js)
// always calls this with no argument. When provided, it's forwarded
// through to performStrandedConversionRecovery() below, which turns it
// into a hard SQL id=ANY() filter — see that function for why this is a
// structural guarantee, not just an environment check.
async function recoverStrandedConversions(candidateIds = null) {
  if (!isRecoveryEnvironmentSafe()) {
    console.warn(
      "\n" +
        "!".repeat(70) +
        "\nSTARTUP CONVERSION RECOVERY SKIPPED — unsafe environment.\n" +
        `NODE_ENV=${JSON.stringify(process.env.NODE_ENV || null)}  ` +
        `STORAGE_PROVIDER=${JSON.stringify(process.env.STORAGE_PROVIDER || null)}\n` +
        "This process is connected to a database but is not recognized as " +
        "the production R2-backed deployment (requires NODE_ENV=production " +
        "AND STORAGE_PROVIDER=r2). Running recovery here could modify real " +
        "production video state using the wrong storage provider — this is " +
        "exactly the incident this guard exists to prevent. Skipping " +
        "entirely; no rows were read or changed.\n" +
        "!".repeat(70) +
        "\n"
    );
    return;
  }

  return performStrandedConversionRecovery(candidateIds);
}

// Shared decision logic for one batch of stranded rows, regardless of
// which status they were found in — same size check, same three
// outcomes, used identically for 'converting' and grace-period-eligible
// 'queued' rows below.
async function recoverRowBatch(rows) {
  let resumed = 0;
  let deferred = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const sizeBytes = await resolveSourceSizeBytes(row);

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

  return { found: rows.length, resumed, deferred, failed };
}

// The actual recovery logic, split out from the environment guard above
// so testConversionRecovery.js can exercise the decision logic directly.
// Application code must always go through the guarded
// recoverStrandedConversions() export above — never call this one
// directly outside of tests.
//
// candidateIds: null in every real production call (server.js never
// passes it) — both queries below then scan the whole table, which is
// safe there because isRecoveryEnvironmentSafe() already gated getting
// this far. testConversionRecovery.js calls this directly WITHOUT going
// through that guard, specifically to exercise the decision logic
// locally — so it always passes its own created row IDs here, which adds
// a hard `id = ANY($1)` filter to both queries. That filter is what
// actually keeps a local test run safe, structurally, regardless of
// NODE_ENV/STORAGE_PROVIDER or which database DATABASE_URL happens to
// point at: a real production row can never match a filter it isn't in,
// full stop. (A prior version of this function had no such filter and,
// combined with a local run against the shared dev/prod database, swept
// up and corrupted two real production rows — this parameter exists
// specifically so that can't happen again.)
async function performStrandedConversionRecovery(candidateIds = null) {
  let convertingRows = [];
  try {
    const result = await client.query(
      `SELECT id, storage_key, source_size_bytes FROM videos
       WHERE processing_status = 'converting'
         AND ($1::int[] IS NULL OR id = ANY($1::int[]))`,
      [candidateIds]
    );
    convertingRows = result.rows;
  } catch (error) {
    console.error("Startup conversion recovery: failed to query stranded 'converting' videos:", error);
  }

  let queuedRows = [];
  try {
    // The cutoff is computed entirely server-side (NOW() minus an
    // interval, both evaluated in Postgres) rather than as a JS Date sent
    // as a parameter — created_at is 'timestamp without time zone', and a
    // JS Date round-tripped through node-postgres against a tz-less
    // column gets reinterpreted using the connecting MACHINE's local
    // timezone, not UTC. On a dev machine in a non-UTC zone that silently
    // shifted the comparison by hours and made every row look too fresh
    // to recover, caught while testing this exact change locally. Doing
    // the whole comparison in one SQL expression avoids the round-trip
    // entirely, so it's correct regardless of what timezone any given
    // machine (dev laptop, Render instance) happens to be configured with.
    const result = await client.query(
      `SELECT id, storage_key, source_size_bytes FROM videos
       WHERE processing_status = 'queued'
         AND created_at < NOW() - ($2::double precision * INTERVAL '1 millisecond')
         AND ($1::int[] IS NULL OR id = ANY($1::int[]))`,
      [candidateIds, QUEUED_RECOVERY_GRACE_PERIOD_MS]
    );
    queuedRows = result.rows;
  } catch (error) {
    console.error("Startup conversion recovery: failed to query stranded 'queued' videos:", error);
  }

  const convertingSummary = await recoverRowBatch(convertingRows);
  const queuedSummary = await recoverRowBatch(queuedRows);

  console.log(
    `Startup conversion recovery — 'converting': found ${convertingSummary.found}, ` +
      `resumed ${convertingSummary.resumed}, deferred ${convertingSummary.deferred} (oversized), ` +
      `failed ${convertingSummary.failed} (size unverifiable).`
  );
  console.log(
    `Startup conversion recovery — 'queued' older than ${Math.round(QUEUED_RECOVERY_GRACE_PERIOD_MS / 1000)}s: ` +
      `found ${queuedSummary.found}, resumed ${queuedSummary.resumed}, ` +
      `deferred ${queuedSummary.deferred} (oversized), failed ${queuedSummary.failed} (size unverifiable).`
  );
}

module.exports = {
  enqueueVideoProcessing,
  enqueueVideoProcessingAsync,
  needsFormatConversion,
  retryConversion,
  recoverStrandedConversions,
  isRecoveryEnvironmentSafe,
  MAX_AUTO_CONVERSION_SIZE_BYTES,
  // Test-only escape hatch for testConversionRecovery.js — bypasses the
  // environment guard on purpose so the decision logic itself is still
  // exercisable locally. Not a supported entry point for application code.
  __performStrandedConversionRecoveryForTests: performStrandedConversionRecovery,
};
