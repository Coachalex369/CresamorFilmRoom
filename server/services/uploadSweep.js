/*
  uploadSweep.js — aborts abandoned multipart upload sessions. An R2/S3
  multipart upload that's never completed or aborted persists (and keeps
  costing storage) indefinitely on its own -- nothing expires it
  automatically. A session can be abandoned for entirely normal reasons
  (the user closed the tab and never came back, the app was uninstalled,
  the file was deleted before resuming) as well as genuine failures, so
  this treats "in_progress and old" as abandoned rather than trying to
  distinguish why.

  Sweeps on inactivity (updated_at), not age since creation (created_at).
  video_uploads.updated_at is bumped on every presign/status call (see
  videoUploads.js) -- real evidence the client is actively working the
  session -- so a legitimate hour-plus upload, or a next-day resume that's
  still progressing, is never destroyed mid-flight just because it started
  a while ago. Only a session that has genuinely gone quiet for the whole
  window gets swept.

  Two ways to run this:
    - startPeriodicSweep() -- an in-process setInterval, started once from
      server/app.js. Beta-appropriate (see rateLimiters.js's own framing),
      not a real cron job: zero new infra, but it only runs while the
      Render dyno is actually up. Free-tier spin-down means an abandoned
      session might wait longer than INACTIVE_AFTER_MS before cleanup --
      a cost-timing issue, not a correctness one. Render's real Cron Jobs
      feature is the correct production upgrade later.
    - node server/scripts/sweepAbandonedUploads.js -- manual/on-demand,
      same convention as backfillR2.js/repairVideo.js.
*/

const client = require("../db/client");
const storage = require("../services/storage/storage");

// Long enough that a genuinely slow/interrupted-but-still-being-resumed
// upload (a coach who'll finish it tomorrow) isn't swept out from under
// them; short enough to bound storage cost for sessions nobody is coming
// back to. Measured from last activity (updated_at), not from when the
// session started -- see the file header. Configurable without a code
// change, same convention as this project's other size/timing constants.
const INACTIVE_AFTER_MS = Number(process.env.UPLOAD_INACTIVE_AFTER_HOURS || 24) * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = Number(process.env.UPLOAD_SWEEP_INTERVAL_HOURS || 6) * 60 * 60 * 1000;

async function sweepAbandonedUploads() {
  if (process.env.STORAGE_PROVIDER !== "r2") {
    return { swept: 0, failed: 0, skipped: "STORAGE_PROVIDER is not r2" };
  }

  const cutoff = new Date(Date.now() - INACTIVE_AFTER_MS);

  const result = await client.query(
    "SELECT * FROM video_uploads WHERE status = 'in_progress' AND updated_at < $1",
    [cutoff]
  );

  let swept = 0;
  let failed = 0;

  for (const row of result.rows) {
    try {
      await storage.abortMultipartUpload(row.storage_key, row.r2_upload_id);
      await client.query("UPDATE video_uploads SET status = 'aborted', updated_at = now() WHERE id = $1", [row.id]);
      swept += 1;
    } catch (error) {
      console.error(`uploadSweep: failed to abort upload session ${row.session_id}:`, error.message);
      failed += 1;
    }
  }

  return { swept, failed, total: result.rows.length };
}

function startPeriodicSweep() {
  if (process.env.STORAGE_PROVIDER !== "r2") return;

  // unref() so this timer alone never keeps a process alive -- the real
  // server already has an HTTP listener for that; a script that merely
  // requires app.js (e.g. testMultipartUploads.js) should still be able to
  // exit on its own once its own work is done.
  const timer = setInterval(() => {
    sweepAbandonedUploads()
      .then(({ swept, failed, total }) => {
        if (total > 0) {
          console.log(`uploadSweep: swept ${swept}/${total} abandoned upload session(s), ${failed} failed`);
        }
      })
      .catch((error) => console.error("uploadSweep: periodic sweep failed:", error));
  }, SWEEP_INTERVAL_MS);
  timer.unref();
}

module.exports = { sweepAbandonedUploads, startPeriodicSweep };
