-- Beta Stabilization Sprint — real MOV-to-MP4 conversion.
--
-- Expands processing_status from the placeholder binary
-- 'processing'/'ready' into a real, user-visible lifecycle:
--   uploading -> queued -> converting -> ready (or failed on a genuine
--   conversion error). A sixth value, 'deferred', is a distinct
--   non-error state for videos that need conversion but exceed the
--   beta automatic-eligibility size cap — never conflated with 'failed'.
--
-- The constraint is widened FIRST so it allows the new values — and
-- deliberately keeps 'processing' in the allowed set too (rather than
-- narrowing it back out), since ADD CONSTRAINT validates every existing
-- row immediately: any row still holding the old value at that instant
-- (before the UPDATE below runs) would otherwise fail the check. A CHECK
-- constraint permanently tolerating one now-unused legacy value is
-- harmless and matches this project's existing additive-migration
-- philosophy (e.g. file_url staying nullable rather than removed).
--
-- Additive only aside from the constraint swap (which only widens the
-- allowed value set); safe to run once against production, safe to re-run.
--
-- TODO(future cleanup migration): once production has run long enough
-- that no row anywhere still has processing_status = 'processing'
-- (confirm via `SELECT count(*) FROM videos WHERE processing_status =
-- 'processing'` returning 0 — the UPDATE below migrates every row that
-- currently has it, so this only matters if something reintroduces the
-- value later), drop 'processing' from this CHECK constraint. Not urgent
-- and not worth doing pre-emptively — a constraint tolerating one unused
-- legacy value is harmless — but it should eventually go so the allowed
-- set doesn't accumulate historical cruft indefinitely.
ALTER TABLE videos DROP CONSTRAINT IF EXISTS videos_processing_status_check;
ALTER TABLE videos ADD CONSTRAINT videos_processing_status_check
  CHECK (processing_status IN ('uploading', 'processing', 'queued', 'converting', 'ready', 'failed', 'deferred'));

UPDATE videos SET processing_status = 'converting' WHERE processing_status = 'processing';

-- Holds the ORIGINAL (pre-conversion) object's key once conversion
-- succeeds and storage_key is swapped to point at the converted MP4.
-- NULL for anything that never needed conversion. The original is never
-- auto-deleted — both objects are only ever removed together, when the
-- video itself is deleted.
ALTER TABLE videos ADD COLUMN IF NOT EXISTS source_storage_key TEXT;

-- A short, non-secret message for the 'failed' state only — never set
-- for 'deferred' (that's a valid, not-erroneous state).
ALTER TABLE videos ADD COLUMN IF NOT EXISTS processing_error TEXT;
