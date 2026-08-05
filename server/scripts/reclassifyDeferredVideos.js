/*
  reclassifyDeferredVideos.js — Play-First Video Pipeline migration tool.
  Admin-only CLI, NOT wired into npm start/dev, never auto-run, no HTTP
  route — same convention as repairVideo.js/backfillR2.js.

  Finds every video stuck in the OLD size-based 'deferred' terminal state
  (or genuinely 'failed') that still has a storage_key, and runs it through
  the new classifyAndRouteOne() pipeline — real ffprobe codec inspection
  instead of a size check. This is the concrete fix for video 274
  (Lex-State-Wrestling.MOV, 654MB, H.264/AAC in a .MOV wrapper) and any
  other rows the old pipeline gave up on purely because of file size.

  Always dry-run by default — lists exactly which rows would be
  reclassified and makes no changes at all unless --confirm is passed.
  Same review-then-change workflow as repairVideo.js.

  Run by hand:
    node server/scripts/reclassifyDeferredVideos.js                # dry run — all eligible rows
    node server/scripts/reclassifyDeferredVideos.js --confirm      # reclassify all eligible rows
    node server/scripts/reclassifyDeferredVideos.js 274            # dry run — just video 274
    node server/scripts/reclassifyDeferredVideos.js 274 --confirm  # reclassify just video 274

  IMPORTANT: classifyAndRouteOne() calls storage.getSignedUrl()/
  storage.upload() through the active STORAGE_PROVIDER — run this from the
  real production environment (STORAGE_PROVIDER=r2), never locally against
  the shared database, same reasoning as every other admin script in this
  project (see repairVideo.js's identical warning).
*/

require("dotenv").config();

const client = require("../db/client");
const { classifyAndRouteOne } = require("../services/videoProcessing");

async function findEligibleVideos(videoIdFilter) {
  if (videoIdFilter) {
    const result = await client.query(
      "SELECT id, title, processing_status, source_size_bytes FROM videos WHERE id = $1 AND storage_key IS NOT NULL",
      [videoIdFilter]
    );
    return result.rows;
  }

  const result = await client.query(
    `SELECT id, title, processing_status, source_size_bytes FROM videos
     WHERE processing_status IN ('deferred', 'failed') AND storage_key IS NOT NULL
     ORDER BY id`
  );
  return result.rows;
}

async function main() {
  const args = process.argv.slice(2);
  const confirm = args.includes("--confirm");
  const idArg = args.find((arg) => /^\d+$/.test(arg));
  const videoIdFilter = idArg ? Number(idArg) : null;

  try {
    const eligible = await findEligibleVideos(videoIdFilter);

    if (!eligible.length) {
      console.log(
        videoIdFilter
          ? `Video ${videoIdFilter} is not in a 'deferred'/'failed' state with a storage_key — nothing to do.`
          : "No 'deferred'/'failed' videos with a storage_key found — nothing to do."
      );
      return;
    }

    console.log(`${confirm ? "Reclassifying" : "Would reclassify"} ${eligible.length} video(s):`);
    for (const video of eligible) {
      const sizeMb = video.source_size_bytes ? Math.round(video.source_size_bytes / 1024 / 1024) : "?";
      console.log(`  #${video.id} "${video.title}" (${video.processing_status}, ~${sizeMb}MB)`);
    }

    if (!confirm) {
      console.log("\nDry run only — no changes made. Re-run with --confirm to actually apply this.");
      return;
    }

    console.log("");
    for (const video of eligible) {
      console.log(`Classifying #${video.id} "${video.title}"...`);
      await classifyAndRouteOne(video.id);

      const result = await client.query(
        "SELECT processing_status, classification, video_codec, audio_codec, container FROM videos WHERE id = $1",
        [video.id]
      );
      const updated = result.rows[0];
      console.log(
        `  -> processing_status=${updated.processing_status} classification=${updated.classification} ` +
          `video_codec=${updated.video_codec} audio_codec=${updated.audio_codec} container=${updated.container}`
      );
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("reclassifyDeferredVideos script failed:", error.message || error);
  process.exit(1);
});
