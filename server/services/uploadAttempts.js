/*
  uploadAttempts.js — Team Highlights, Slice 1. Durable tracking and real
  server-side idempotency for the direct-to-R2 upload lifecycle, layered
  underneath POST /api/upload-video without changing its external
  contract for existing callers (idempotency_key is optional — a legacy
  caller that omits it gets a server-generated one, no dedup benefit, but
  identical behavior to today).

  A database transaction cannot include the external R2 write, so this is
  NOT one literal transaction — it's a sequence of durable, individually
  committed states, each guarded by lease-token fencing so a process that
  wakes up after losing ownership (lease reclaimed by the sweeper) can
  never advance the row further:

    1. claimOrGetAttempt()      -- atomic claim via INSERT ... ON CONFLICT
                                    DO NOTHING; every branch (fresh claim,
                                    idempotent replay of a completed
                                    attempt, in-progress, or reset of a
                                    failed/cleaned-up one) is handled here.
    2. (caller mints the storage key)
    3. persistUploadingState()  -- storage_key + status='uploading' +
                                    lease committed BEFORE any R2 call, so
                                    every possible object has a discoverable
                                    key even if the process crashes next.
    4. (caller performs storage.upload())
    5. markR2Uploaded()
    6. completeAttempt()        -- the one real DB transaction: INSERT
                                    videos, INSERT team_highlights (if
                                    applicable), and the attempt's own
                                    'completed' update, all together.

  Every step after claim takes the current lease_token and includes
  "AND lease_token = $expected" in its WHERE clause. Zero rows affected
  means ownership was already reclaimed (by the sweeper, after this
  process's lease expired) — the caller must stop immediately and must
  not advance the attempt any further; see LEASE_LOST below.
*/

const crypto = require("crypto");
const client = require("../db/client");
const storage = require("./storage/storage");

const LEASE_MINUTES = Number(process.env.UPLOAD_ATTEMPT_LEASE_MINUTES) || 60;
const SWEEPER_LEASE_MINUTES = 5;

function leaseLostError() {
  const error = new Error("Lost ownership of this upload attempt (lease expired or reclaimed)");
  error.code = "LEASE_LOST";
  return error;
}

// Every branch of the idempotency-key state machine — the single entry
// point every upload request calls first, before touching R2 at all.
async function claimOrGetAttempt({ userId, idempotencyKey, teamId, uploadDestination }) {
  const newToken = crypto.randomUUID();

  const insertResult = await client.query(
    `
    INSERT INTO upload_attempts
      (user_id, idempotency_key, team_id, upload_destination, status, attempt_count, lease_token, lease_expires_at, last_heartbeat_at)
    VALUES ($1, $2, $3, $4, 'pending', 1, $5, now() + ($6 || ' minutes')::interval, now())
    ON CONFLICT (user_id, idempotency_key) DO NOTHING
    RETURNING *
    `,
    [userId, idempotencyKey, teamId, uploadDestination, newToken, String(LEASE_MINUTES)]
  );

  if (insertResult.rows.length > 0) {
    return { attempt: insertResult.rows[0], freshClaim: true };
  }

  // Lost the initial claim — this idempotency key already has a row.
  // Never independently begin an R2 upload from here; branch on its
  // actual state instead.
  const existing = await client.query(
    "SELECT * FROM upload_attempts WHERE user_id = $1 AND idempotency_key = $2",
    [userId, idempotencyKey]
  );
  const row = existing.rows[0];

  if (row.status === "completed") {
    return { attempt: row, freshClaim: false, alreadyCompleted: true };
  }

  // A replay of a key whose prior upload succeeded and later had its
  // resulting video physically purged (sourceRetention.js's finalizePurge)
  // -- deliberately its own terminal outcome, checked BEFORE the
  // failed/cleaned_up reset branch below so it can never be confused with
  // either. Not resettable: unlike a genuinely failed/cleaned-up attempt
  // (where nothing permanent happened and a retry is the obviously correct
  // behavior), this key already resolved to a real result that a human
  // deliberately removed -- silently minting a brand-new upload under the
  // SAME idempotency key would surprise a caller who still believes that
  // key names the original, now-gone video. The caller must be told
  // explicitly and, if they want to upload again, do so under a new key.
  if (row.status === "source_purged") {
    return { attempt: row, freshClaim: false, sourcePurged: true };
  }

  if (row.status === "failed" || row.status === "cleaned_up") {
    // Fully resettable: clear the prior key/result fields, bump
    // attempt_count, mint a fresh lease — the NEXT step mints a NEW
    // storage key too, never reusing the old one. Atomic conditional
    // update: only succeeds if the row is STILL resettable at this
    // instant, guarding a race between two simultaneous replay requests.
    const resetResult = await client.query(
      `
      UPDATE upload_attempts
      SET status = 'pending', storage_key = NULL, video_id = NULL, team_highlight_id = NULL,
          attempt_count = attempt_count + 1, lease_token = $1,
          lease_expires_at = now() + ($2 || ' minutes')::interval,
          last_heartbeat_at = now(), last_error = NULL, updated_at = now()
      WHERE id = $3 AND status IN ('failed', 'cleaned_up')
      RETURNING *
      `,
      [newToken, String(LEASE_MINUTES), row.id]
    );
    if (resetResult.rows.length > 0) {
      return { attempt: resetResult.rows[0], freshClaim: true };
    }
    // Lost the reset race to a concurrent replay — fall through and
    // report whatever its current state actually is.
  }

  const current = await client.query("SELECT * FROM upload_attempts WHERE id = $1", [row.id]);
  // Normally pending / uploading / r2_uploaded / cleanup_pending at this
  // point (completed and source_purged both returned above already; a lost
  // failed/cleaned_up reset race lands here too). Reported as in-progress
  // either way, including the theoretical extreme case where the reset
  // race's winner raced all the way to completed/source_purged between
  // this function's own checks above and this re-fetch -- a caller told
  // "in progress, retry shortly" simply observes the correct terminal
  // branch on its very next replay, so this is never unsafe, only
  // occasionally one extra round trip.
  return { attempt: current.rows[0], freshClaim: false, inProgress: true };
}

async function persistUploadingState(attemptId, leaseToken, storageKey) {
  const result = await client.query(
    `
    UPDATE upload_attempts
    SET storage_key = $1, status = 'uploading', last_heartbeat_at = now(), updated_at = now()
    WHERE id = $2 AND lease_token = $3
    RETURNING *
    `,
    [storageKey, attemptId, leaseToken]
  );
  if (result.rows.length === 0) throw leaseLostError();
  return result.rows[0];
}

// Best-effort heartbeat during a genuinely long upload (wired to
// @aws-sdk/lib-storage's httpUploadProgress event, throttled by the
// caller — not every progress tick). Returns false rather than throwing
// on lease loss, since a heartbeat failing mid-upload should let the
// caller decide whether to abort the in-flight R2 write, not crash.
async function renewLease(attemptId, leaseToken) {
  const result = await client.query(
    `
    UPDATE upload_attempts
    SET lease_expires_at = now() + ($1 || ' minutes')::interval, last_heartbeat_at = now(), updated_at = now()
    WHERE id = $2 AND lease_token = $3 AND status IN ('uploading', 'r2_uploaded')
    RETURNING id
    `,
    [String(LEASE_MINUTES), attemptId, leaseToken]
  );
  return result.rows.length > 0;
}

async function markR2Uploaded(attemptId, leaseToken) {
  const result = await client.query(
    `
    UPDATE upload_attempts
    SET status = 'r2_uploaded', last_heartbeat_at = now(), updated_at = now()
    WHERE id = $1 AND lease_token = $2
    RETURNING *
    `,
    [attemptId, leaseToken]
  );
  if (result.rows.length === 0) throw leaseLostError();
  return result.rows[0];
}

// The one real DB transaction: videos + team_highlights (if applicable) +
// the attempt's own completion, together. Re-checks lease ownership under
// a row lock inside the transaction too, so a sweeper reclaiming the
// lease at this exact moment can't interleave with the commit.
async function completeAttempt(
  attemptId,
  leaseToken,
  { title, storageKey, userId, teamId, uploadDestination, filmType, fileSize }
) {
  const conn = await client.connect();
  try {
    await conn.query("BEGIN");

    const attemptResult = await conn.query("SELECT * FROM upload_attempts WHERE id = $1 FOR UPDATE", [attemptId]);
    const attempt = attemptResult.rows[0];
    if (!attempt || attempt.lease_token !== leaseToken) {
      await conn.query("ROLLBACK");
      throw leaseLostError();
    }

    const videoInsert = await conn.query(
      `
      INSERT INTO videos (title, storage_key, uploaded_by, processing_status, team_id, film_type, source_size_bytes, upload_destination)
      VALUES ($1, $2, $3, 'uploading', $4, $5, $6, $7)
      RETURNING *
      `,
      [title, storageKey, userId, teamId || null, filmType || null, fileSize, uploadDestination]
    );
    const video = videoInsert.rows[0];

    let teamHighlight = null;
    if (uploadDestination === "team_highlights") {
      const highlightInsert = await conn.query(
        "INSERT INTO team_highlights (video_id, team_id, created_by) VALUES ($1, $2, $3) RETURNING *",
        [video.id, teamId, userId]
      );
      teamHighlight = highlightInsert.rows[0];
    }

    await conn.query(
      `
      UPDATE upload_attempts
      SET status = 'completed', video_id = $1, team_highlight_id = $2, updated_at = now()
      WHERE id = $3
      `,
      [video.id, teamHighlight ? teamHighlight.id : null, attemptId]
    );

    await conn.query("COMMIT");
    return { video, teamHighlight };
  } catch (error) {
    await conn.query("ROLLBACK");
    throw error;
  } finally {
    conn.release();
  }
}

// Called by the route immediately after completeAttempt() throws for any
// reason OTHER than lease loss (a genuine DB error on the video/post
// insert) — the R2 object already exists at this point (step 4/5 already
// succeeded) but nothing in the DB references it. Best-effort, synchronous,
// immediate cleanup attempt; a durable cleanup_pending record is left
// behind if that immediate attempt also fails, for the sweeper to retry.
async function handleCompletionFailureCleanup(attemptId, leaseToken, storageKey) {
  try {
    await storage.removeVerified(storageKey);
    await client.query(
      "UPDATE upload_attempts SET status = 'cleaned_up', updated_at = now() WHERE id = $1 AND lease_token = $2",
      [attemptId, leaseToken]
    );
  } catch (error) {
    await client.query(
      "UPDATE upload_attempts SET status = 'cleanup_pending', last_error = $1, updated_at = now() WHERE id = $2 AND lease_token = $3",
      [String(error.message).slice(0, 500), attemptId, leaseToken]
    );
  }
}

async function markFailed(attemptId, leaseToken, errorMessage) {
  // Intentionally does not check rows-affected / throw here — this IS the
  // failure path; if the lease was already lost, whoever reclaimed it now
  // owns this row's fate, and a no-op here is correct, not an error.
  await client.query(
    "UPDATE upload_attempts SET status = 'failed', last_error = $1, updated_at = now() WHERE id = $2 AND lease_token = $3",
    [String(errorMessage).slice(0, 500), attemptId, leaseToken]
  );
}

// Sweeper: reclaims every attempt whose lease has expired, via the same
// atomic conditional-claim pattern used everywhere else in this file
// (only succeeds if the lease is STILL expired at the exact moment of the
// update — guards two concurrent sweeper passes/instances from both
// acting on the same row). This is also exactly what fences out a late-
// waking original request: the moment this claim succeeds, the row's
// lease_token changes, so any subsequent WHERE lease_token=<old> update
// from the original process matches zero rows.
async function sweepUploadAttempts({ limit = 50 } = {}) {
  const expired = await client.query(
    `
    SELECT id FROM upload_attempts
    WHERE lease_expires_at < now()
      AND status IN ('pending', 'uploading', 'r2_uploaded', 'cleanup_pending')
    ORDER BY lease_expires_at ASC
    LIMIT $1
    `,
    [limit]
  );

  let cleaned = 0;
  let stillRetrying = 0;
  let markedFailed = 0;

  for (const row of expired.rows) {
    try {
      const sweeperToken = crypto.randomUUID();
      const claim = await client.query(
        `
        UPDATE upload_attempts
        SET lease_token = $1, lease_expires_at = now() + ($2 || ' minutes')::interval, updated_at = now()
        WHERE id = $3 AND lease_expires_at < now()
        RETURNING *
        `,
        [sweeperToken, String(SWEEPER_LEASE_MINUTES), row.id]
      );
      if (claim.rows.length === 0) continue; // another sweeper pass/instance already claimed it

      const attempt = claim.rows[0];

      if (attempt.status === "pending") {
        // Never minted a key — nothing could exist in R2 for this attempt.
        await client.query(
          "UPDATE upload_attempts SET status = 'failed', last_error = 'Abandoned before upload started', updated_at = now() WHERE id = $1 AND lease_token = $2",
          [attempt.id, sweeperToken]
        );
        markedFailed += 1;
        continue;
      }

      // uploading / r2_uploaded / cleanup_pending — a real object may exist
      // (or already partially/fully landed, even if the DB never heard
      // back). removeVerified() tolerates an already-absent object as
      // success, so this is safe to attempt regardless of which of these
      // three exact states brought us here.
      try {
        await storage.removeVerified(attempt.storage_key);
        await client.query(
          "UPDATE upload_attempts SET status = 'cleaned_up', updated_at = now() WHERE id = $1 AND lease_token = $2",
          [attempt.id, sweeperToken]
        );
        cleaned += 1;
      } catch (error) {
        await client.query(
          "UPDATE upload_attempts SET status = 'cleanup_pending', last_error = $1, updated_at = now() WHERE id = $2 AND lease_token = $3",
          [String(error.message).slice(0, 500), attempt.id, sweeperToken]
        );
        stillRetrying += 1;
      }
    } catch (error) {
      // Unexpected failure (e.g. a transient DB error on the claim itself)
      // must not abort the rest of this batch -- the row's lease is still
      // expired, so it stays eligible and is simply retried next pass.
      console.error(`sweepUploadAttempts: row ${row.id} failed, will retry next pass:`, error.message);
    }
  }

  return { expiredCount: expired.rows.length, cleaned, stillRetrying, markedFailed };
}

module.exports = {
  claimOrGetAttempt,
  persistUploadingState,
  renewLease,
  markR2Uploaded,
  completeAttempt,
  handleCompletionFailureCleanup,
  markFailed,
  sweepUploadAttempts,
};
