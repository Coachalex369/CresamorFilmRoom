/*
  sourceRetention.js — Team Highlights, Slice 1. The reference-safe R2
  retention / physical-purge state machine, and the shared row-locking
  protocol every reference-creating route must use so it can never race
  a concurrent purge.

  Three ways a video can end up physically purged, all funneled through
  the same two building blocks below:
    1. A direct DELETE /api/videos/:id call (attemptPurge) — synchronous
       from the caller's perspective, since an explicit "delete this now"
       request expects a definite answer, not a queued outcome.
    2. A reference-removal event (film-removal today; a Team Highlight
       post removal in Slice 2; a future clip deletion/materialization)
       marks the video for reevaluation IN THE SAME TRANSACTION as the
       removal itself (markForPurgeReevaluation) — cheap, no locking, no
       R2 call, so the user-facing request stays fast. The sweeper picks
       these up later (sweepPurgeReevaluations).
    3. A prior purge attempt whose R2 delete failed leaves the video at
       purge_status='purge_pending' — the sweeper retries finalizePurge
       directly (sweepStuckPurges).

  Building blocks:
    lockCountAndMaybeFlipToPurgePending(videoId) — the ONLY place that
      decides eligibility. Locks the row (SELECT ... FOR UPDATE), counts
      live references, and — still under that same lock, in the same
      transaction — either leaves the row untouched or flips it to
      purge_pending. This is what makes the decision race-safe: any
      reference-creating route that ALSO locks this row before inserting
      (assertNotPurgePending below) is strictly ordered against this
      transaction by Postgres itself, not by application timing.
    finalizePurge(videoId) — everything after eligibility is confirmed:
      delete the R2 object(s) OUTSIDE any DB transaction (a database
      transaction cannot include the external R2 call), then, only once
      that succeeds, run the final DELETE FROM videos in its own short
      transaction. Preserves every cleanup step the original
      DELETE /api/videos/:id performed (storage_key, source_storage_key,
      thumbnail_url, the security_audit_log entry) — the one thing it no
      longer does is pre-delete clips, since a video only ever reaches
      finalizePurge with zero unmaterialized clips already confirmed.

  R2 deletion cannot be rolled back through PostgreSQL — this is exactly
  why the DB state transition (locked, counted, flipped, committed) always
  happens BEFORE R2 is ever touched, and why a failed R2 delete leaves the
  row at purge_pending (never reverted to active — flip-flopping would
  reopen the window for new references mid-cleanup) for the sweeper to
  retry, rather than being treated as a rollback signal.
*/

const client = require("../db/client");
const storage = require("../services/storage/storage");
const { logSecurityEvent } = require("./auditLog");

function deleteLocalFileIfPresent(fileUrl) {
  if (!fileUrl || /^https?:\/\//i.test(fileUrl)) return;
  const fs = require("fs");
  const path = require("path");
  const localPath = path.join(__dirname, "../..", fileUrl);
  fs.unlink(localPath, (err) => {
    if (err && err.code !== "ENOENT") {
      console.error("Failed to delete local file:", localPath, err);
    }
  });
}

// Live, authoritative reference counts — never a maintained counter
// column. A materialized clip (storage_key IS NOT NULL) does not count:
// it no longer depends on the full source.
async function countActiveReferences(conn, videoId) {
  const posts = await conn.query(
    "SELECT COUNT(*)::int AS count FROM team_highlights WHERE video_id = $1 AND removed_at IS NULL",
    [videoId]
  );
  const clips = await conn.query(
    "SELECT COUNT(*)::int AS count FROM clips WHERE video_id = $1 AND storage_key IS NULL",
    [videoId]
  );
  return {
    activePosts: posts.rows[0].count,
    unmaterializedClips: clips.rows[0].count,
  };
}

// Team Highlights, Slice 2: the raw row-lock, extracted out of
// lockAndAssertNotPurgePending below so a caller that needs to apply its
// OWN error-shaping (e.g. POST /api/teams/:teamId/highlights, which must
// never let a caller distinguish "doesn't exist" from "exists but
// belongs to another team" from "exists but is mid-purge" -- see that
// route's own comments) can still use the identical lock query, in the
// identical order, rather than duplicating the SQL. Returns the row or
// null; never throws on its own.
async function lockVideoRow(conn, videoId) {
  const result = await conn.query("SELECT * FROM videos WHERE id = $1 FOR UPDATE", [videoId]);
  return result.rows[0] || null;
}

// The shared row-locking protocol every reference-creating route must use
// BEFORE inserting a new clip or Team Highlight post, inside that same
// route's own transaction. Locking the identical row this function's
// sibling (lockCountAndMaybeFlipToPurgePending) also locks is what makes
// reference-creation and the purge decision mutually exclusive — a plain
// unlocked read of purge_status is not sufficient, since it could observe
// 'active' an instant before a concurrent purge transaction flips it.
// Throws if the video doesn't exist or is not eligible; callers should
// catch and translate to their own 403/404/409 as appropriate. Still the
// right choice for clips.js's POST /api/clips, where existence and
// purge-pending ARE both safe to reveal distinctly to a caller who has
// already separately proven view authorization on the video itself.
async function lockAndAssertNotPurgePending(conn, videoId) {
  const video = await lockVideoRow(conn, videoId);
  if (!video) {
    const error = new Error("Video not found");
    error.code = "VIDEO_NOT_FOUND";
    throw error;
  }
  if (video.purge_status !== "active") {
    const error = new Error("This video is no longer available");
    error.code = "VIDEO_PURGE_PENDING";
    throw error;
  }
  return video;
}

// The eligibility decision, race-safe by construction (see file header).
// Returns { transitioned, activePosts, unmaterializedClips }. Never
// touches R2 — that's finalizePurge's job, deliberately kept out of any
// DB transaction.
async function lockCountAndMaybeFlipToPurgePending(videoId) {
  const conn = await client.connect();
  try {
    await conn.query("BEGIN");

    const videoResult = await conn.query("SELECT * FROM videos WHERE id = $1 FOR UPDATE", [videoId]);
    const video = videoResult.rows[0];
    if (!video) {
      await conn.query("ROLLBACK");
      return { transitioned: false, videoExists: false, activePosts: 0, unmaterializedClips: 0 };
    }

    if (video.purge_status === "purge_pending") {
      // Idempotent re-entry — a sweeper pass retrying its own prior
      // decision, or a race with another concurrent caller. Nothing new
      // to decide.
      await conn.query("COMMIT");
      return { transitioned: false, videoExists: true, alreadyPending: true, activePosts: 0, unmaterializedClips: 0 };
    }

    const { activePosts, unmaterializedClips } = await countActiveReferences(conn, videoId);

    if (activePosts > 0 || unmaterializedClips > 0) {
      await conn.query("ROLLBACK");
      return { transitioned: false, videoExists: true, activePosts, unmaterializedClips };
    }

    await conn.query("UPDATE videos SET purge_status = 'purge_pending' WHERE id = $1", [videoId]);
    await conn.query("COMMIT");
    return { transitioned: true, videoExists: true, activePosts: 0, unmaterializedClips: 0 };
  } catch (error) {
    await conn.query("ROLLBACK");
    throw error;
  } finally {
    conn.release();
  }
}

// R2 deletion, then final DB cleanup — only ever called for a video
// already at purge_status='purge_pending'. Safe to call more than once
// for the same video (the sweeper's retry path does exactly that):
// removeVerified() treats an already-absent object as success, so a
// second pass after a prior partial failure simply confirms the object
// is gone and proceeds to the DB delete it didn't reach last time.
async function finalizePurge(videoId, { actingUserId = null } = {}) {
  const videoResult = await client.query("SELECT * FROM videos WHERE id = $1 AND purge_status = 'purge_pending'", [videoId]);
  const video = videoResult.rows[0];
  if (!video) {
    // Already fully purged (row gone) or never reached purge_pending —
    // nothing for this call to do.
    return { outcome: "no_op" };
  }

  try {
    if (video.storage_key) {
      await storage.removeVerified(video.storage_key);
    } else {
      deleteLocalFileIfPresent(video.file_url);
    }

    if (video.source_storage_key && video.source_storage_key !== video.storage_key) {
      await storage.removeVerified(video.source_storage_key);
    }
  } catch (error) {
    console.error(`finalizePurge: R2 deletion failed for video ${videoId}, will retry later:`, error.message);
    return { outcome: "r2_delete_failed" };
  }

  deleteLocalFileIfPresent(video.thumbnail_url);

  // The final delete. team_highlights/clips FKs are ON DELETE SET NULL —
  // any historical row referencing this video survives with its pointer
  // cleared; an ACTIVE team_highlights post cannot exist here at all (the
  // team_highlights_active_needs_source constraint would reject this
  // delete outright if one somehow did, last-resort defense in depth
  // behind the locking protocol above). upload_attempts is handled at the
  // SCHEMA level, not here: a BEFORE DELETE trigger
  // (trg_detach_completed_upload_attempts, migration 018) moves any
  // 'completed' referencing row to 'source_purged' before this DELETE's
  // own FK cascade runs, so this is safe no matter what deletes the video
  // -- this call, a test script's cleanup, or any future admin script.
  // (Originally handled with an explicit UPDATE right here instead of a
  // trigger; moved to a trigger after discovering every one of this
  // project's existing test scripts does its own direct DELETE FROM
  // videos in cleanup and hit the identical constraint violation, proving
  // this needs to be a schema guarantee, not a per-caller one.)
  await client.query("DELETE FROM videos WHERE id = $1", [videoId]);

  // Correction: kept as the established 'video_deleted' event name, not
  // renamed to 'video_purged'. This is externally meaningful behavior
  // (anything consuming security_audit_log keys off event_type) -- a
  // rename here was an internal naming preference during this rewrite,
  // not a proven production requirement, and the default is to preserve
  // an established contract rather than break it to match new internal
  // terminology. "Purge" is still the right word in code/comments for
  // this specific physical-deletion path; the logged event name is not.
  await logSecurityEvent("video_deleted", {
    userId: actingUserId,
    metadata: { videoId, uploadedBy: video.uploaded_by },
  });

  return { outcome: "purged" };
}

// Direct, synchronous purge attempt — used by DELETE /api/videos/:id.
// The caller (the route) is responsible for authorization (canDeleteVideo)
// BEFORE calling this; this function only decides and acts on eligibility.
async function attemptPurge(videoId, actingUserId = null) {
  const decision = await lockCountAndMaybeFlipToPurgePending(videoId);

  if (!decision.videoExists) {
    return { outcome: "not_found" };
  }
  if (decision.alreadyPending) {
    // Another purge is already in flight for this row — let the sweeper
    // finish it rather than racing a second finalize attempt here.
    return { outcome: "already_pending" };
  }
  if (!decision.transitioned) {
    return {
      outcome: "blocked",
      activePosts: decision.activePosts,
      unmaterializedClips: decision.unmaterializedClips,
    };
  }

  return finalizePurge(videoId, { actingUserId });
}

// Called INSIDE the same transaction as a reference-removal event
// (film-removal today; Team Highlight post removal in Slice 2; a future
// clip deletion/materialization) — cheap, no locking beyond the row the
// caller's own UPDATE already touches, no R2 call. This is what
// guarantees the cleanup request can never be silently lost even if a
// separate follow-up statement would have failed: there is no separate
// follow-up statement, the caller's own removal UPDATE and this one
// commit or roll back together.
function markForPurgeReevaluationSql() {
  return "UPDATE videos SET purge_reevaluation_requested_at = now() WHERE id = $1";
}

// Sweeper entry point: finds every video someone asked to have
// reevaluated, and — for each — runs the SAME eligibility decision used
// everywhere else, then (only if eligible) finalizes, all outside any
// user-facing request. A video that was simply removed from Film and
// still has real references is untouched here; a video that was never
// marked (the common case — most Film/Team Film content has no reason to
// ever be reevaluated) is never even considered, matching "an active Film
// source is not automatically purged merely because it currently has no
// clips/posts."
async function sweepPurgeReevaluations({ limit = 50 } = {}) {
  const candidates = await client.query(
    `
    SELECT id FROM videos
    WHERE purge_reevaluation_requested_at IS NOT NULL AND purge_status = 'active'
    ORDER BY purge_reevaluation_requested_at ASC
    LIMIT $1
    `,
    [limit]
  );

  let purged = 0;
  let retained = 0;

  for (const row of candidates.rows) {
    try {
      const decision = await lockCountAndMaybeFlipToPurgePending(row.id);
      // Clear the flag regardless of outcome -- either it's now
      // purge_pending (about to be finalized below) or the references that
      // remain are the current, correct reason not to purge; either way
      // there's nothing stale left for a future pass to "catch up" on
      // unless another reference-removal event re-marks it.
      await client.query("UPDATE videos SET purge_reevaluation_requested_at = NULL WHERE id = $1", [row.id]);

      if (decision.transitioned) {
        await finalizePurge(row.id);
        purged += 1;
      } else {
        retained += 1;
      }
    } catch (error) {
      // One row's unexpected failure (e.g. a transient DB error) must not
      // abort the rest of this batch -- it stays flagged and is simply
      // retried on the next periodic pass.
      console.error(`sweepPurgeReevaluations: row ${row.id} failed, will retry next pass:`, error.message);
    }
  }

  return { candidateCount: candidates.rows.length, purged, retained };
}

// Sweeper entry point: retries R2 deletion + finalization for any video
// stuck at purge_status='purge_pending' from a prior failed attempt.
async function sweepStuckPurges({ limit = 50 } = {}) {
  const candidates = await client.query(
    "SELECT id FROM videos WHERE purge_status = 'purge_pending' ORDER BY id ASC LIMIT $1",
    [limit]
  );

  let purged = 0;
  let stillStuck = 0;

  for (const row of candidates.rows) {
    try {
      const result = await finalizePurge(row.id);
      if (result.outcome === "purged") purged += 1;
      else if (result.outcome === "r2_delete_failed") stillStuck += 1;
    } catch (error) {
      // Same isolation rationale as sweepPurgeReevaluations above -- the
      // row stays at purge_pending and is retried next pass rather than
      // aborting the rest of this batch.
      console.error(`sweepStuckPurges: row ${row.id} failed, will retry next pass:`, error.message);
    }
  }

  return { candidateCount: candidates.rows.length, purged, stillStuck };
}

module.exports = {
  countActiveReferences,
  lockVideoRow,
  lockAndAssertNotPurgePending,
  lockCountAndMaybeFlipToPurgePending,
  finalizePurge,
  attemptPurge,
  markForPurgeReevaluationSql,
  sweepPurgeReevaluations,
  sweepStuckPurges,
};
