-- Team Highlights, Slice 1 — CONTRACT migration (expand/deploy/contract,
-- part 2 of 2; companion to 018_team_highlights_retention.sql).
--
-- DO NOT APPLY THIS UNTIL:
--   1. 018_team_highlights_retention.sql has already been applied to
--      production, AND
--   2. this branch's code (which always writes a non-NULL
--      upload_destination on every new video -- see POST /api/upload-video
--      in server/routes/videos.js) has already been deployed to Render
--      and smoke-tested against a real upload.
--
-- Applying this before both of those are true will start rejecting any
-- still-live old-code upload the instant its INSERT INTO videos omits
-- upload_destination -- the exact regression this two-file split exists
-- to prevent. See 018's header for the full expand/deploy/contract
-- rationale.
--
-- NUMBERING NOTE: chosen as 019 against main as of the 018 branch's most
-- recent rebase (main's highest migration was 017 at that time). Other
-- migrations may land on main before this is actually ready to apply --
-- re-check `server/db/migrations/` on main immediately before applying
-- and renumber this file first if 019 is no longer free. Do not apply
-- under a stale/colliding number.

-- Re-backfill: covers two groups in one idempotent pass -- (a) any row
-- that predates 018 and was somehow missed, and (b) every row created by
-- old, still-deployed code DURING the rollout window between 018 landing
-- and this branch's own deploy (old code's INSERT never mentions
-- upload_destination, so those rows landed at NULL). Same classification
-- rule as 018, applied again here because it's still correct for both
-- groups -- there's no way to distinguish "pre-018" from "rollout-window"
-- rows structurally, and none is needed since the rule is identical.
UPDATE videos SET upload_destination = 'personal'
  WHERE team_id IS NULL AND upload_destination IS NULL;
UPDATE videos SET upload_destination = 'team_film'
  WHERE team_id IS NOT NULL AND upload_destination IS NULL;

-- Fail safely rather than silently forcing NOT NULL onto data this
-- migration doesn't actually know how to classify. team_id is always
-- either NULL or NOT NULL, so the two UPDATEs above are exhaustive in
-- principle -- this exists as a named, readable guard in case that
-- invariant is ever wrong in practice, instead of letting the next
-- statement fail with a generic constraint-violation error.
DO $$
DECLARE
  remaining_nulls INTEGER;
BEGIN
  SELECT COUNT(*) INTO remaining_nulls FROM videos WHERE upload_destination IS NULL;
  IF remaining_nulls > 0 THEN
    RAISE EXCEPTION
      'Contract migration aborted: % videos row(s) still have NULL upload_destination after backfill -- investigate before retrying',
      remaining_nulls;
  END IF;
END $$;

-- Second guard: rows that already have a non-NULL destination but don't
-- actually match team_id (e.g. from some future code path this migration
-- wasn't written against). The final CHECK constraint below would catch
-- this anyway and abort, but with a much less readable generic Postgres
-- error -- this gives a human a named, specific reason first.
DO $$
DECLARE
  inconsistent_rows INTEGER;
BEGIN
  SELECT COUNT(*) INTO inconsistent_rows FROM videos
  WHERE NOT (
    (upload_destination = 'personal' AND team_id IS NULL) OR
    (upload_destination = 'team_film' AND team_id IS NOT NULL) OR
    (upload_destination = 'team_highlights' AND team_id IS NOT NULL)
  );
  IF inconsistent_rows > 0 THEN
    RAISE EXCEPTION
      'Contract migration aborted: % videos row(s) have a destination inconsistent with their team_id -- investigate before retrying',
      inconsistent_rows;
  END IF;
END $$;

-- Both guards passed: every row has a valid, consistent, non-NULL
-- destination. Safe to tighten now.
ALTER TABLE videos ALTER COLUMN upload_destination SET NOT NULL;

-- Replace the expansion migration's NULL-tolerant version with the final,
-- strict form -- upload_destination can no longer be NULL by this point,
-- so the "upload_destination IS NULL OR" branch is dead weight, not a
-- loophole (already enforced by the NOT NULL just above), but dropping it
-- keeps the constraint's intent honest for anyone reading it later.
ALTER TABLE videos DROP CONSTRAINT IF EXISTS videos_destination_team_consistency;
ALTER TABLE videos ADD CONSTRAINT videos_destination_team_consistency CHECK (
  (upload_destination = 'personal' AND team_id IS NULL) OR
  (upload_destination = 'team_film' AND team_id IS NOT NULL) OR
  (upload_destination = 'team_highlights' AND team_id IS NOT NULL)
);
