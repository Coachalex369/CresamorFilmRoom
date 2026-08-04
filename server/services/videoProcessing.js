/*
  videoProcessing.js — video processing pipeline (Foundation Sprint Phase 3).

  No real transcoding or thumbnailing exists yet. What changed in Phase 3:
  the upload route no longer awaits this before responding (see
  server/app.js's POST /api/upload-video) — this now genuinely runs after
  the HTTP response has gone out, transitioning the row through real
  states (uploading -> processing -> ready/failed) instead of blocking the
  request on a same-tick status flip. That's the actual point of this
  phase: when real transcoding lands and takes minutes instead of
  milliseconds, the request/response contract already doesn't assume it's
  fast — no route changes will be needed, only what happens inside this
  file.

  Pipeline (target shape):
    Upload -> Validate -> Store Upload Record (status='uploading') ->
    enqueueVideoProcessingAsync (status='processing') ->
    Video Converter (TODO) -> Thumbnail Generator (TODO) -> status='ready'
    (or 'failed' on error)
*/

const client = require("../db/client");

// Playback-fix pass: browsers (especially non-Safari) don't reliably play
// .MOV directly, and this pipeline has no real transcoder yet (see TODOs
// below). Rather than mark these 'ready' and let the player hit a decode
// error, they're detected here and held at 'processing' — the client shows
// a "requires conversion" message for that case instead of a spinner.
//
// R2 migration fix: storage_key rows leave file_url NULL (see
// ARCHITECTURE.md's "Storage strategy"), so this has to check storage_key
// first — checking file_url alone silently never detected .MOV on any
// R2-routed upload, a real bug introduced by that migration and caught
// while implementing the opaque-key refinement. storage_key still carries
// a real file extension (UUID-named, not filename-preserving, but the
// extension itself isn't identifying info) specifically so this keeps
// working.
function needsFormatConversion(video) {
  const source = video.storage_key || video.file_url || "";
  return /\.mov(\?.*)?$/i.test(source);
}

async function enqueueVideoProcessing(video) {
  await client.query(
    `UPDATE videos SET processing_status = 'processing' WHERE id = $1`,
    [video.id]
  );

  // TODO(next phase): remove this artificial delay the moment real work
  // (transcoding/thumbnailing) happens below — it exists only so
  // "processing" is genuinely observable by client-side polling during
  // development, instead of always resolving before anyone could see it.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  // TODO(next phase): replace the delay above with a real queue push (a
  // jobs table + worker process, or a hosted queue service) instead of
  // doing the "work" inline in this same async call.
  // TODO(next phase): plug video transcoding/compression in here — this is
  // also where a MOV input would get converted to MP4/H.264 and its
  // file_url swapped to the converted output before ever calling this
  // 'ready'.
  // TODO(next phase): plug real thumbnail generation in here, setting
  // videos.thumbnail_url (column added in migration 005 — currently
  // always null; nothing reads it yet either, see the Phase 3 report for
  // why generating it wasn't done this phase).

  if (needsFormatConversion(video)) {
    const stillProcessing = await client.query(
      `SELECT * FROM videos WHERE id = $1`,
      [video.id]
    );

    return stillProcessing.rows[0];
  }

  const result = await client.query(
    `UPDATE videos SET processing_status = 'ready' WHERE id = $1 RETURNING *`,
    [video.id]
  );

  return result.rows[0];
}

// Fire-and-forget wrapper for the upload route: the HTTP response must not
// wait on this, and a failure here must not become an unhandled promise
// rejection — mark the row 'failed' instead so client-side polling (see
// GET /api/videos/:id) has something real to observe either way.
async function enqueueVideoProcessingAsync(video) {
  try {
    await enqueueVideoProcessing(video);
  } catch (error) {
    console.error("Video processing failed:", error);

    try {
      await client.query(
        `UPDATE videos SET processing_status = 'failed' WHERE id = $1`,
        [video.id]
      );
    } catch (updateError) {
      console.error("Failed to mark video as failed:", updateError);
    }
  }
}

module.exports = {
  enqueueVideoProcessing,
  enqueueVideoProcessingAsync,
  needsFormatConversion,
};
