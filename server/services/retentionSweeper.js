/*
  retentionSweeper.js — Team Highlights, Slice 1. Combines the three
  periodic sweeps this feature needs (expired upload-attempt leases, purge
  reevaluation requests, stuck purge_pending rows) into one orchestration
  point, called once at boot (same structural guarantee as
  recoverStrandedConversions() in videoProcessing.js — only ever runs
  after the HTTP server is already accepting requests, never before or
  instead of that) and then on a periodic timer.

  Beta-appropriate, same stance as rateLimiters.js/uploadSweep-style
  in-process timers elsewhere in this project's own history: an
  in-process interval, not a real job scheduler — fine for a single
  Render instance, easy to replace later without an architecture change.
*/

const uploadAttempts = require("./uploadAttempts");
const sourceRetention = require("./sourceRetention");

const SWEEP_INTERVAL_MS = Number(process.env.RETENTION_SWEEP_INTERVAL_MS) || 5 * 60 * 1000;

let sweepTimer = null;

async function runRetentionSweep() {
  const results = {};

  try {
    results.uploadAttempts = await uploadAttempts.sweepUploadAttempts();
  } catch (error) {
    console.error("retentionSweeper: sweepUploadAttempts failed:", error);
  }

  try {
    results.purgeReevaluations = await sourceRetention.sweepPurgeReevaluations();
  } catch (error) {
    console.error("retentionSweeper: sweepPurgeReevaluations failed:", error);
  }

  try {
    results.stuckPurges = await sourceRetention.sweepStuckPurges();
  } catch (error) {
    console.error("retentionSweeper: sweepStuckPurges failed:", error);
  }

  return results;
}

function startPeriodicRetentionSweep() {
  if (sweepTimer) return; // idempotent — never double-schedule
  sweepTimer = setInterval(() => {
    runRetentionSweep().catch((error) => {
      console.error("retentionSweeper: periodic sweep failed:", error);
    });
  }, SWEEP_INTERVAL_MS);
  // Never keeps the process alive on its own (matches this project's
  // existing timer conventions) — a clean shutdown isn't blocked by this.
  if (sweepTimer.unref) sweepTimer.unref();
}

function stopPeriodicRetentionSweep() {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

module.exports = { runRetentionSweep, startPeriodicRetentionSweep, stopPeriodicRetentionSweep };
