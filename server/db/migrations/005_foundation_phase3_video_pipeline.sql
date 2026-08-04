-- Foundation Sprint — Phase 3: Video pipeline refactor.
--
-- Locks down processing_status to a real, documented state machine and
-- adds the thumbnail_url seam. Additive/constraint-only — no data loss.
-- Both existing video rows are already 'ready', so this CHECK is safe to
-- add immediately (verified before writing this migration).

-- Postgres has no ADD CONSTRAINT IF NOT EXISTS, so guard it manually to
-- keep this migration safe to re-run like every other one in this directory.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'videos_processing_status_check'
  ) THEN
    ALTER TABLE videos ADD CONSTRAINT videos_processing_status_check
      CHECK (processing_status IN ('uploading', 'processing', 'ready', 'failed'));
  END IF;
END $$;

-- Thumbnail pipeline seam (schema only this phase — see
-- server/services/videoProcessing.js for why real generation is deferred).
ALTER TABLE videos ADD COLUMN IF NOT EXISTS thumbnail_url TEXT;
