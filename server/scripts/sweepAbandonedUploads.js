/*
  sweepAbandonedUploads.js — manual/on-demand run of the same sweep that
  runs periodically in-process (see server/services/uploadSweep.js's
  startPeriodicSweep(), started from server/app.js). Same convention as
  backfillR2.js/repairVideo.js: NOT wired into npm start/dev on its own,
  run by hand:

    node server/scripts/sweepAbandonedUploads.js

  after STORAGE_PROVIDER=r2 and the R2 env vars are set. Useful right after
  deploying this feature (nothing has swept anything yet) or any time you
  want an out-of-band cleanup pass without waiting for the periodic timer.
*/

require("dotenv").config();

const client = require("../db/client");
const { sweepAbandonedUploads } = require("../services/uploadSweep");

async function main() {
  if (process.env.STORAGE_PROVIDER !== "r2") {
    console.error("STORAGE_PROVIDER is not 'r2' — nothing to sweep (multipart uploads are R2-only).");
    process.exitCode = 1;
    return;
  }

  console.log("Sweeping abandoned multipart uploads...");
  const result = await sweepAbandonedUploads();
  console.log(`Swept ${result.swept}, failed ${result.failed}, out of ${result.total} in_progress session(s) old enough to sweep.`);
}

main()
  .catch((error) => {
    console.error("Sweep script failed:", error);
    process.exitCode = 1;
  })
  .finally(() => client.end());
