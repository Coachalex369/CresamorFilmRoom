/*
  testConversionRecovery.js — regression test for recoverStrandedConversions()
  (server-side conversion recovery redesign, replacing the disabled
  boot-time requeue that caused the earlier 502 incident) AND for the
  environment safety guard added after a follow-up incident: a stray
  local dev server, pointed at the shared production database with the
  local storage provider active, ran this exact recovery logic against
  real production rows. isRecoveryEnvironmentSafe() now requires
  NODE_ENV=production AND STORAGE_PROVIDER=r2 before recoverStrandedConversions()
  does anything at all.

  Two things are exercised here, deliberately kept separate:
    - The GUARD itself, via the real recoverStrandedConversions() export,
      in this environment's actual (non-production) env — must leave a
      'converting' row completely untouched.
    - The DECISION LOGIC (size checks, deferred/resumed/failed outcomes),
      via __performStrandedConversionRecoveryForTests — the guard's
      unguarded inner implementation, exported only for this script.
      Application code must never call that export directly; only the
      guarded recoverStrandedConversions() is a supported entry point.

  The R2 HeadObjectCommand fallback code path itself (getObjectSize in
  r2Storage.js) is structurally identical to localStorage.js's
  fs.stat-based version exercised here, and is verified for real on
  production post-deploy, same convention as testAuth.js's note on signed
  R2 playback not being locally testable.

  Run by hand: node server/scripts/testConversionRecovery.js
*/

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const client = require("../db/client");
const {
  recoverStrandedConversions,
  isRecoveryEnvironmentSafe,
  __performStrandedConversionRecoveryForTests: performStrandedConversionRecovery,
  retryConversion,
  MAX_AUTO_CONVERSION_SIZE_BYTES,
} = require("../services/videoProcessing");

const RUN_TAG = `convrecovery_${Date.now()}`;
const TEST_DIR = path.join(__dirname, "../../uploads", "convrecovery-test");

const results = [];
function assert(name, condition, detail) {
  results.push({ name, pass: Boolean(condition) });
  console.log(`${condition ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
}

async function main() {
  const createdVideoIds = [];

  try {
    const userResult = await client.query("SELECT id FROM users LIMIT 1");
    const testUserId = userResult.rows[0].id;

    fs.mkdirSync(TEST_DIR, { recursive: true });

    // Case 0: the environment guard itself. This script runs with this
    // environment's real NODE_ENV/STORAGE_PROVIDER (not production/r2),
    // so the GUARDED export must refuse to touch anything at all.
    assert(
      "sanity: this test environment is correctly NOT recognized as safe for recovery",
      isRecoveryEnvironmentSafe() === false,
      `NODE_ENV=${process.env.NODE_ENV || "(unset)"}, STORAGE_PROVIDER=${process.env.STORAGE_PROVIDER || "(unset)"}`
    );

    const guardInsert = await client.query(
      `INSERT INTO videos (title, storage_key, uploaded_by, processing_status, source_size_bytes)
       VALUES ($1, $2, $3, 'converting', $4) RETURNING id`,
      [`${RUN_TAG}-guard-check`, `convrecovery-test/${RUN_TAG}-guard-check.mov`, testUserId, 1024]
    );
    createdVideoIds.push(guardInsert.rows[0].id);

    await recoverStrandedConversions();

    const guardCheck = await client.query(
      `SELECT processing_status, processing_error FROM videos WHERE id = $1`,
      [guardInsert.rows[0].id]
    );
    assert(
      "guard: unsafe environment leaves a 'converting' row completely untouched",
      guardCheck.rows[0].processing_status === "converting" && guardCheck.rows[0].processing_error === null,
      `status=${guardCheck.rows[0].processing_status}`
    );

    // Case 1: known size (source_size_bytes set), UNDER the cap — should
    // reset to 'queued' and get enqueued. The actual conversion attempt
    // then fails locally on "ffmpeg not found" (this environment has no
    // ffmpeg binary) — a separate, expected limitation, not what this
    // case is checking; only "did recovery resume it" matters here.
    const smallKey = `convrecovery-test/${RUN_TAG}-small.mov`;
    fs.writeFileSync(path.join(__dirname, "../../uploads", smallKey), Buffer.alloc(1024, 1));
    const smallInsert = await client.query(
      `INSERT INTO videos (title, storage_key, uploaded_by, processing_status, source_size_bytes)
       VALUES ($1, $2, $3, 'converting', $4) RETURNING id`,
      [`${RUN_TAG}-small`, smallKey, testUserId, 1024]
    );
    createdVideoIds.push(smallInsert.rows[0].id);

    // Case 2: known size, OVER the cap — should revert to 'deferred',
    // never enqueued. This is the case that directly guards against
    // repeating the original 502 incident (blindly resuming a large
    // file's conversion at boot).
    const bigInsert = await client.query(
      `INSERT INTO videos (title, storage_key, uploaded_by, processing_status, source_size_bytes)
       VALUES ($1, $2, $3, 'converting', $4) RETURNING id`,
      [
        `${RUN_TAG}-big`,
        `convrecovery-test/${RUN_TAG}-big.mov`,
        testUserId,
        MAX_AUTO_CONVERSION_SIZE_BYTES + 1,
      ]
    );
    createdVideoIds.push(bigInsert.rows[0].id);

    // Case 3: NULL source_size_bytes (a legacy row), real file present and
    // small — the storage.getObjectSize() fallback should find it and
    // resume it.
    const legacySmallKey = `convrecovery-test/${RUN_TAG}-legacy-small.mov`;
    fs.writeFileSync(path.join(__dirname, "../../uploads", legacySmallKey), Buffer.alloc(2048, 1));
    const legacySmallInsert = await client.query(
      `INSERT INTO videos (title, storage_key, uploaded_by, processing_status, source_size_bytes)
       VALUES ($1, $2, $3, 'converting', NULL) RETURNING id`,
      [`${RUN_TAG}-legacy-small`, legacySmallKey, testUserId]
    );
    createdVideoIds.push(legacySmallInsert.rows[0].id);

    // Case 4: NULL source_size_bytes, file MISSING — the fallback check
    // itself fails, so this must be marked 'failed' with a
    // processing_error, never left stuck at 'converting' and never
    // blindly resumed without knowing its size.
    const legacyMissingInsert = await client.query(
      `INSERT INTO videos (title, storage_key, uploaded_by, processing_status, source_size_bytes)
       VALUES ($1, $2, $3, 'converting', NULL) RETURNING id`,
      [
        `${RUN_TAG}-legacy-missing`,
        `convrecovery-test/${RUN_TAG}-legacy-missing.mov`,
        testUserId,
      ]
    );
    createdVideoIds.push(legacyMissingInsert.rows[0].id);

    // Case 5: a video already correctly resting at 'deferred' must be
    // completely untouched — confirms the recovery query stays scoped to
    // 'converting' only, never broadened to 'deferred'.
    const deferredInsert = await client.query(
      `INSERT INTO videos (title, storage_key, uploaded_by, processing_status, source_size_bytes)
       VALUES ($1, $2, $3, 'deferred', $4) RETURNING id`,
      [
        `${RUN_TAG}-already-deferred`,
        `convrecovery-test/${RUN_TAG}-already-deferred.mov`,
        testUserId,
        MAX_AUTO_CONVERSION_SIZE_BYTES + 1,
      ]
    );
    createdVideoIds.push(deferredInsert.rows[0].id);

    // Case 6/7: retryConversion() must apply the same size cap as
    // recovery — a manual retry of an oversized file OOM'd the 512MB
    // production instance for real, which is the incident this fix is
    // for. Neither case should ever spawn FFmpeg.
    const retryBigInsert = await client.query(
      `INSERT INTO videos (title, storage_key, uploaded_by, processing_status, source_size_bytes)
       VALUES ($1, $2, $3, 'failed', $4) RETURNING id`,
      [
        `${RUN_TAG}-retry-big`,
        `convrecovery-test/${RUN_TAG}-retry-big.mov`,
        testUserId,
        MAX_AUTO_CONVERSION_SIZE_BYTES + 1,
      ]
    );
    createdVideoIds.push(retryBigInsert.rows[0].id);

    const retryBigOutcome = await retryConversion(retryBigInsert.rows[0].id);
    assert(
      "retryConversion: oversized -> stays 'deferred', no FFmpeg launched",
      retryBigOutcome.outcome === "oversized" && retryBigOutcome.processing_status === "deferred",
      `outcome=${retryBigOutcome.outcome}`
    );

    const retryMissingInsert = await client.query(
      `INSERT INTO videos (title, storage_key, uploaded_by, processing_status, source_size_bytes)
       VALUES ($1, $2, $3, 'failed', NULL) RETURNING id`,
      [`${RUN_TAG}-retry-missing`, `convrecovery-test/${RUN_TAG}-retry-missing.mov`, testUserId]
    );
    createdVideoIds.push(retryMissingInsert.rows[0].id);

    const retryMissingOutcome = await retryConversion(retryMissingInsert.rows[0].id);
    assert(
      "retryConversion: size unverifiable -> 'failed', no FFmpeg launched",
      retryMissingOutcome.outcome === "size_unverifiable" && retryMissingOutcome.processing_status === "failed",
      `outcome=${retryMissingOutcome.outcome}`
    );

    // Deliberately the unguarded inner implementation, not the guarded
    // recoverStrandedConversions() export — see the file header. Case 0
    // above already confirmed the guard itself works; these cases are
    // testing the decision logic the guard wraps.
    await performStrandedConversionRecovery();

    // Give the single-flight queue a moment to finish the fast,
    // locally-failing (no ffmpeg binary) conversion attempts.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const finalStates = await client.query(
      `SELECT id, processing_status, processing_error FROM videos WHERE id = ANY($1::int[])`,
      [createdVideoIds]
    );
    const byId = Object.fromEntries(finalStates.rows.map((r) => [r.id, r]));

    const small = byId[smallInsert.rows[0].id];
    assert(
      "known-size, under cap -> resumed (no longer stuck at 'converting')",
      small.processing_status !== "converting",
      `status=${small.processing_status}`
    );

    const big = byId[bigInsert.rows[0].id];
    assert(
      "known-size, over cap -> reverted to 'deferred', not enqueued",
      big.processing_status === "deferred",
      `status=${big.processing_status}`
    );

    const legacySmall = byId[legacySmallInsert.rows[0].id];
    assert(
      "NULL size + file present under cap -> fallback check resumed it",
      legacySmall.processing_status !== "converting",
      `status=${legacySmall.processing_status}`
    );

    const legacyMissing = byId[legacyMissingInsert.rows[0].id];
    assert(
      "NULL size + file missing -> marked 'failed' with a processing_error",
      legacyMissing.processing_status === "failed" && Boolean(legacyMissing.processing_error),
      `status=${legacyMissing.processing_status}, error=${legacyMissing.processing_error}`
    );

    const deferred = byId[deferredInsert.rows[0].id];
    assert(
      "pre-existing 'deferred' row is untouched by recovery",
      deferred.processing_status === "deferred",
      `status=${deferred.processing_status}`
    );
  } finally {
    if (createdVideoIds.length) {
      await client.query(`DELETE FROM videos WHERE id = ANY($1::int[])`, [createdVideoIds]);
    }
    fs.rmSync(TEST_DIR, { recursive: true, force: true });

    const failed = results.filter((r) => !r.pass).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed.`);
    await client.end();
    process.exit(failed ? 1 : 0);
  }
}

main();
