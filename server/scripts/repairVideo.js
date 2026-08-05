/*
  repairVideo.js — admin-only CLI for videoProcessing.js's repairVideo().
  NOT wired into npm start/dev, never auto-run, not exposed via any HTTP
  route — same convention as backfillR2.js. Built for exactly one
  situation: a video's processing_status/processing_error got corrupted
  by something other than a genuine conversion failure (see: video 78,
  swept up and given a local-filesystem error by test code that has since
  been fixed to make this structurally impossible).

  Always dry-run by default — shows the row's current state and exactly
  what would change, and makes no changes at all unless --confirm is
  explicitly passed. This mirrors the review-then-change workflow used to
  actually repair video 78 (show state -> "this is exactly the field(s) I
  intend to change" -> only then act).

  Run by hand:
    node server/scripts/repairVideo.js <videoId>            # dry run — shows state only, changes nothing
    node server/scripts/repairVideo.js <videoId> --confirm  # actually repairs it

  IMPORTANT: storage.exists() is provider-aware — run this locally
  (STORAGE_PROVIDER unset, local disk active), it checks THIS MACHINE's
  filesystem, not R2, which would silently and wrongly report a real
  production object as missing. Caught while building this, and fixed by
  making repairVideo() itself refuse to run at all outside the real
  production R2 environment (isRecoveryEnvironmentSafe()) — this script
  mirrors that same check before even attempting to describe the object's
  existence, rather than showing a number that could be flatly wrong.
  Run this from the actual production environment (e.g. Render's shell),
  not a local machine.
*/

require("dotenv").config();

const client = require("../db/client");
const storage = require("../services/storage/storage");
const { repairVideo, isRecoveryEnvironmentSafe } = require("../services/videoProcessing");

async function describeState(video) {
  const safeToCheckStorage = isRecoveryEnvironmentSafe();
  const currentExists = safeToCheckStorage && video.storage_key ? await storage.exists(video.storage_key) : null;

  console.log("Current state:");
  console.log(`  processing_status:    ${video.processing_status}`);
  console.log(`  processing_error:     ${video.processing_error || "(none)"}`);
  console.log(`  storage_key:          ${video.storage_key || "(none)"}`);
  console.log(`  source_size_bytes:    ${video.source_size_bytes === null ? "(null)" : video.source_size_bytes}`);

  if (!safeToCheckStorage) {
    console.log(
      "  R2 object exists?     UNKNOWN — this process is not the production R2 environment " +
        `(NODE_ENV=${JSON.stringify(process.env.NODE_ENV || null)}, STORAGE_PROVIDER=${JSON.stringify(process.env.STORAGE_PROVIDER || null)}), ` +
        "so this can't be checked from here without risking a wrong answer."
    );
    console.log("  converted object exists? UNKNOWN — same reason as above.");
    return;
  }

  console.log(`  R2 object exists?     ${currentExists}`);

  if (video.source_storage_key) {
    // A conversion previously succeeded for this row — storage_key is the
    // converted object, source_storage_key is the original.
    console.log(`  converted object exists? ${currentExists} (storage_key already points at the converted file)`);
  } else {
    console.log(
      "  converted object exists? n/a — no conversion has ever succeeded for this row " +
        "(source_storage_key is null; storage_key is still the original upload)"
    );
  }
}

async function main() {
  const [videoIdArg, ...flags] = process.argv.slice(2);
  const confirm = flags.includes("--confirm");

  if (!videoIdArg || !/^\d+$/.test(videoIdArg)) {
    console.error("Usage: node server/scripts/repairVideo.js <videoId> [--confirm]");
    process.exitCode = 1;
    return;
  }

  const videoId = Number(videoIdArg);

  try {
    const result = await client.query("SELECT * FROM videos WHERE id = $1", [videoId]);
    const video = result.rows[0];

    if (!video) {
      console.error(`Video ${videoId} not found.`);
      process.exitCode = 1;
      return;
    }

    await describeState(video);

    if (video.processing_status !== "failed") {
      console.log(
        `\nrepairVideo() only ever touches a 'failed' row — this one is '${video.processing_status}', ` +
          "so there is nothing for this script to do."
      );
      return;
    }

    console.log(
      "\nThis is exactly the field(s) repairVideo() will change:\n" +
        "  processing_status -> 'queued'\n" +
        "  processing_error  -> NULL\n" +
        "storage_key and every other field are left untouched."
    );

    if (!confirm) {
      console.log("\nDry run only — no changes made. Re-run with --confirm to actually apply this.");
      return;
    }

    if (!isRecoveryEnvironmentSafe()) {
      console.log(
        "\nRefusing to apply: this process is not the production R2 environment. " +
          "repairVideo() would throw for the same reason — run this script from the real " +
          "production environment (e.g. Render's shell) to actually repair the row."
      );
      process.exitCode = 1;
      return;
    }

    const repaired = await repairVideo(videoId);
    console.log("\nRepaired:");
    console.log(`  processing_status: ${repaired.processing_status}`);
    console.log(`  processing_error:  ${repaired.processing_error || "(none)"}`);
    console.log(`  enqueued now:      ${repaired.enqueued}`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("repairVideo script failed:", error.message || error);
  process.exit(1);
});
