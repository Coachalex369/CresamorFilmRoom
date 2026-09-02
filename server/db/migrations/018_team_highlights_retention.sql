-- Team Highlights, Slice 1 — EXPANSION migration (expand/deploy/contract).
--
-- Additive only, same discipline as every prior migration: no DROP, no
-- data loss. This file is deliberately backward-compatible with the code
-- currently deployed on Render: applying it must never break a live
-- upload from the code running right now, before this branch deploys.
--
-- videos.upload_destination is added NULLABLE here, on purpose, and is
-- NOT given a NOT NULL constraint in this file. Currently-deployed
-- production code's POST /api/upload-video INSERT does not (and cannot,
-- without a code deploy) supply this column -- if this migration made it
-- NOT NULL immediately, every live upload between "migration applied" and
-- "new code deployed" would start failing with a constraint violation.
-- The companion contract migration (019, applied only after the new code
-- is deployed and smoke-tested) is what finishes tightening this to
-- NOT NULL. See that file's header for the full expand/deploy/contract
-- rationale.

-- ============================================================
-- videos: destination classification + logical removal + purge state
-- ============================================================

-- upload_destination: a video's intended routing/presentation home —
-- 'personal' (uploader-private, team_id NULL), 'team_film' (coach-managed
-- breakdown library), or 'team_highlights' (parent/athlete/coach-published
-- team-visible highlight). Distinct from team_id, which remains the
-- ACCESS-CONTROL dimension (canViewVideo/canAccessTeam, unchanged) —
-- upload_destination is descriptive/routing only. Backfilled below for
-- every row that exists right now; deliberately left NULLABLE (not NOT
-- NULL yet) so old, still-deployed code's INSERT INTO videos (which never
-- mentions this column) keeps succeeding, landing new rows at NULL until
-- the new code deploys. The contract migration re-backfills those.
ALTER TABLE videos ADD COLUMN IF NOT EXISTS upload_destination TEXT
  CHECK (upload_destination IN ('personal', 'team_film', 'team_highlights'));

-- Idempotent backfill: every existing team_id IS NULL row (including
-- Chad's videos 525/526) becomes 'personal', exactly matching current
-- behavior (team_id NULL has always meant uploader-private since the
-- Personal Film authorization fix). Every existing team-assigned row
-- becomes 'team_film', since 'team_highlights' as a concept did not exist
-- before this migration — nothing could have been destined for it.
UPDATE videos SET upload_destination = 'personal'
  WHERE team_id IS NULL AND upload_destination IS NULL;
UPDATE videos SET upload_destination = 'team_film'
  WHERE team_id IS NOT NULL AND upload_destination IS NULL;

-- Deliberately NOT run in this migration: ALTER TABLE videos ALTER COLUMN
-- upload_destination SET NOT NULL. See file header -- that happens in the
-- contract migration, after deploy.

-- Expansion-phase version: explicitly tolerates upload_destination IS
-- NULL (old code's still-live INSERTs), on top of the same three-way
-- consistency rule for whichever rows already do have a destination.
-- Written as an explicit "IS NULL OR (...)" rather than relying on SQL's
-- NULL-comparison semantics (a bare "x = 'personal' AND ..." already
-- often passes a CHECK when x IS NULL, since CHECK only rejects on an
-- explicit FALSE, not NULL) -- spelled out here so the NULL-tolerance is
-- unambiguous and intentional, not an implicit accident of three-valued
-- logic. The contract migration drops and replaces this with the final,
-- strict, non-NULL-tolerant version once NOT NULL is in place.
ALTER TABLE videos DROP CONSTRAINT IF EXISTS videos_destination_team_consistency;
ALTER TABLE videos ADD CONSTRAINT videos_destination_team_consistency CHECK (
  upload_destination IS NULL OR
  (upload_destination = 'personal' AND team_id IS NULL) OR
  (upload_destination = 'team_film' AND team_id IS NOT NULL) OR
  (upload_destination = 'team_highlights' AND team_id IS NOT NULL)
);

-- Logical "Remove from Film": hides a source from the Film library
-- listing without touching the row or its R2 object. Completely
-- orthogonal to purge eligibility (see purge_status/purge_reevaluation_
-- requested_at below) — a video can be removed from Film and still be
-- fully intact because an active Team Highlight post or personal clip
-- depends on it; conversely a video can remain fully visible in Film
-- forever with zero clips/posts and is NEVER auto-purged, since nothing
-- ever marks it for reevaluation (see purge_reevaluation_requested_at).
ALTER TABLE videos ADD COLUMN IF NOT EXISTS film_removed_at TIMESTAMPTZ;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS film_removed_by INTEGER REFERENCES users(id);

-- Physical-purge state. 'active' is the only state a video normally sits
-- in; 'purge_pending' is a short-lived, durable marker meaning "eligibility
-- was confirmed under a row lock, no new clip/highlight reference may be
-- created against this source anymore, and R2 deletion is in progress or
-- awaiting retry." There is no third 'purged' value — a fully purged
-- video's row no longer exists at all, so nothing would ever read it.
ALTER TABLE videos ADD COLUMN IF NOT EXISTS purge_status TEXT NOT NULL DEFAULT 'active'
  CHECK (purge_status IN ('active', 'purge_pending'));

-- Durable "please reevaluate this source's purge eligibility" marker, set
-- IN THE SAME TRANSACTION as whatever reference-removal event might have
-- brought this video's reference count to zero (film-removal below;
-- Team Highlight post removal in Slice 2; a future clip
-- deletion/materialization event) — never as a separate, unprotected
-- follow-up write, so the cleanup request can never be silently lost if
-- a second statement failed. The sweeper clears this once it has made a
-- decision (retain, or transition to purge_pending).
ALTER TABLE videos ADD COLUMN IF NOT EXISTS purge_reevaluation_requested_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_videos_purge_reevaluation
  ON videos (purge_reevaluation_requested_at)
  WHERE purge_reevaluation_requested_at IS NOT NULL AND purge_status = 'active';

CREATE INDEX IF NOT EXISTS idx_videos_purge_pending
  ON videos (id) WHERE purge_status = 'purge_pending';

-- ============================================================
-- clips: reserved future materialization + guaranteed backing source
-- ============================================================

-- video_id becomes nullable and its FK becomes ON DELETE SET NULL so a
-- future materialized clip (storage_key set, no longer dependent on the
-- full source) can survive the source's eventual physical purge without
-- either blocking that purge or being destroyed by it. Every clip created
-- by this feature (and by every existing code path) still populates
-- video_id and leaves storage_key NULL — this is a dormant schema
-- capability, not a behavior change. See clips_has_backing_source below
-- for the guarantee that makes the eventual transition safe.
ALTER TABLE clips ALTER COLUMN video_id DROP NOT NULL;
ALTER TABLE clips ADD COLUMN IF NOT EXISTS storage_key TEXT;

ALTER TABLE clips DROP CONSTRAINT IF EXISTS clips_video_id_fkey;
ALTER TABLE clips ADD CONSTRAINT clips_video_id_fkey
  FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE SET NULL;

-- A clip must never exist with neither a source reference nor its own
-- object — this is what makes the future materialization transition safe
-- at the database level, not just by convention: video_id may only be
-- cleared AFTER storage_key has already been set (attempting the reverse
-- order is rejected outright by this constraint).
ALTER TABLE clips DROP CONSTRAINT IF EXISTS clips_has_backing_source;
ALTER TABLE clips ADD CONSTRAINT clips_has_backing_source
  CHECK (video_id IS NOT NULL OR storage_key IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_clips_dependent_by_video
  ON clips (video_id) WHERE storage_key IS NULL;

-- ============================================================
-- team_highlights: the "post" layer, deliberately separate from videos
-- ============================================================

-- A Team Highlight post references a source video but is independently
-- removable (removed_at) without ever touching the source row or any
-- personal clip made from it. This table is created here (Slice 1) but
-- stays completely inert until Slice 2 adds the routes that write to it —
-- no client or route in this slice references it yet.
CREATE TABLE IF NOT EXISTS team_highlights (
  id SERIAL PRIMARY KEY,
  video_id INTEGER REFERENCES videos(id) ON DELETE SET NULL,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at TIMESTAMPTZ,
  removed_by INTEGER REFERENCES users(id),
  -- An ACTIVE post (removed_at NULL) must always have a real video_id —
  -- the only way video_id may be NULL is if the post is also removed.
  -- Real, load-bearing defense in depth: if the application-level purge
  -- guard were ever wrong and let a physical delete proceed while an
  -- active post still existed, the resulting ON DELETE SET NULL would
  -- violate this constraint and Postgres would refuse the whole
  -- operation, rather than silently leaving an active post pointing at
  -- nothing.
  CONSTRAINT team_highlights_active_needs_source
    CHECK (removed_at IS NOT NULL OR video_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_team_highlights_active_by_team
  ON team_highlights (team_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_team_highlights_active_by_video
  ON team_highlights (video_id) WHERE removed_at IS NULL;

-- Prevents the same source from being actively published twice to the
-- same team; republishing after a prior post was removed remains allowed
-- (the uniqueness only applies to WHERE removed_at IS NULL rows).
CREATE UNIQUE INDEX IF NOT EXISTS idx_team_highlights_one_active_per_team_video
  ON team_highlights (team_id, video_id) WHERE removed_at IS NULL;

-- ============================================================
-- upload_attempts: durable tracking for the direct-to-R2 upload lifecycle
-- ============================================================

-- Tracks one logical upload attempt from idempotency-key claim through
-- completion (or failure/cleanup), independent of and prior to the
-- videos/team_highlights rows it may eventually produce. Exists so that
-- "R2 succeeded but the DB step failed" (and every other crash window in
-- the upload path) leaves a durable, discoverable record rather than a
-- silent orphan only logs would show.
CREATE TABLE IF NOT EXISTS upload_attempts (
  id SERIAL PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  team_id INTEGER REFERENCES teams(id),
  upload_destination TEXT NOT NULL
    CHECK (upload_destination IN ('personal', 'team_film', 'team_highlights')),
  storage_key TEXT,
  -- 'source_purged': a completed attempt whose resulting video was later
  -- physically purged (see sourceRetention.js's finalizePurge). Distinct
  -- from 'completed' specifically so upload_attempts_completed_needs_video
  -- below can keep meaning what it says -- a genuinely 'completed' row
  -- always has a live video_id; a row whose source is gone transitions
  -- here instead, explicitly, rather than being silently left 'completed'
  -- with a NULLed video_id by the videos FK's ON DELETE SET NULL action
  -- (which would otherwise violate that exact constraint the instant a
  -- purge ran -- found by actually running the purge suite locally, not
  -- by inspection).
  status TEXT NOT NULL CHECK (status IN
    ('pending', 'uploading', 'r2_uploaded', 'completed', 'failed', 'cleanup_pending', 'cleaned_up', 'source_purged')),
  attempt_count INTEGER NOT NULL DEFAULT 1,
  -- Lease fencing: lease_token changes identity every time ownership of
  -- an in-flight attempt moves from one process to another (the original
  -- request renews its OWN token while it's actively working; a sweeper
  -- reclaiming an expired lease mints a NEW token). Every state-changing
  -- UPDATE this feature issues includes "AND lease_token = $expected" in
  -- its WHERE clause — a late-waking original process whose lease was
  -- already reclaimed matches zero rows and must stop, rather than racing
  -- the sweeper that's now cleaning up its object.
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  last_heartbeat_at TIMESTAMPTZ,
  last_error TEXT,
  video_id INTEGER REFERENCES videos(id) ON DELETE SET NULL,
  team_highlight_id INTEGER REFERENCES team_highlights(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);

ALTER TABLE upload_attempts DROP CONSTRAINT IF EXISTS upload_attempts_destination_team_consistency;
ALTER TABLE upload_attempts ADD CONSTRAINT upload_attempts_destination_team_consistency CHECK (
  (upload_destination = 'personal' AND team_id IS NULL) OR
  (upload_destination = 'team_film' AND team_id IS NOT NULL) OR
  (upload_destination = 'team_highlights' AND team_id IS NOT NULL)
);

-- Every state past the initial claim genuinely has an R2 object (or did,
-- before cleanup) — 'pending' (not yet minted) and 'failed' (cleared on
-- reset) are the only states allowed to have no key. 'source_purged' keeps
-- its storage_key too -- it's a historical record that a real object
-- existed, even though the video row and the object itself are both gone
-- by the time a row reaches this state.
ALTER TABLE upload_attempts DROP CONSTRAINT IF EXISTS upload_attempts_object_states_need_key;
ALTER TABLE upload_attempts ADD CONSTRAINT upload_attempts_object_states_need_key CHECK (
  status NOT IN ('uploading', 'r2_uploaded', 'completed', 'cleanup_pending', 'cleaned_up', 'source_purged')
  OR storage_key IS NOT NULL
);

ALTER TABLE upload_attempts DROP CONSTRAINT IF EXISTS upload_attempts_completed_needs_video;
ALTER TABLE upload_attempts ADD CONSTRAINT upload_attempts_completed_needs_video CHECK (
  status != 'completed' OR video_id IS NOT NULL
);

ALTER TABLE upload_attempts DROP CONSTRAINT IF EXISTS upload_attempts_completed_highlights_needs_post;
ALTER TABLE upload_attempts ADD CONSTRAINT upload_attempts_completed_highlights_needs_post CHECK (
  status != 'completed' OR upload_destination != 'team_highlights' OR team_highlight_id IS NOT NULL
);

-- A Personal Film or Team Film attempt must never claim a Team Highlight
-- result, regardless of status — team_highlight_id is only ever
-- meaningful for upload_destination = 'team_highlights'.
ALTER TABLE upload_attempts DROP CONSTRAINT IF EXISTS upload_attempts_non_highlights_no_post;
ALTER TABLE upload_attempts ADD CONSTRAINT upload_attempts_non_highlights_no_post CHECK (
  upload_destination = 'team_highlights' OR team_highlight_id IS NULL
);

-- Every state where a process (the original request or the sweeper) may
-- still be actively working the attempt must carry real lease-ownership
-- fields — matches the fencing design above. Terminal states ('completed',
-- 'failed', 'cleaned_up') don't require a currently-meaningful lease.
ALTER TABLE upload_attempts DROP CONSTRAINT IF EXISTS upload_attempts_active_states_need_lease;
ALTER TABLE upload_attempts ADD CONSTRAINT upload_attempts_active_states_need_lease CHECK (
  status NOT IN ('pending', 'uploading', 'r2_uploaded', 'cleanup_pending')
  OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
);

-- The sweeper's own query: every non-terminal state, ordered by lease
-- expiry, so it can cheaply find exactly the rows eligible for reclaim
-- without a full table scan.
CREATE INDEX IF NOT EXISTS idx_upload_attempts_sweeper
  ON upload_attempts (lease_expires_at)
  WHERE status IN ('pending', 'uploading', 'r2_uploaded', 'cleanup_pending');

-- Correction (found by actually running the full local regression suite,
-- not by inspection): sourceRetention.js's finalizePurge() originally
-- handled the 'completed' -> 'source_purged' detach itself, as an
-- explicit UPDATE immediately before its own DELETE FROM videos. That
-- only protected THAT one call site. Every one of this project's existing
-- test scripts' cleanup code (testAuth.js, testConversionRecovery.js,
-- testVideoClassification.js, testVideoVisibility.js, and this feature's
-- own testTeamHighlightsRetention.js) also issues a plain, direct
-- DELETE FROM videos in its own cleanup -- none of them know about, or
-- should need to know about, upload_attempts' completed-needs-video rule.
-- Every one of them hit the exact same constraint violation the instant
-- their deleted video had a completed upload_attempts row, proving this
-- needs to be a schema-level guarantee, not a per-caller discipline.
-- A BEFORE DELETE trigger runs before Postgres's own FK ON DELETE SET
-- NULL action, so it always gets first chance to move any completed
-- attempt out of the way, regardless of which code issued the DELETE.
CREATE OR REPLACE FUNCTION detach_completed_upload_attempts_before_video_delete()
RETURNS trigger AS $$
BEGIN
  UPDATE upload_attempts
  SET video_id = NULL, status = 'source_purged', updated_at = now()
  WHERE video_id = OLD.id AND status = 'completed';
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_detach_completed_upload_attempts ON videos;
CREATE TRIGGER trg_detach_completed_upload_attempts
  BEFORE DELETE ON videos
  FOR EACH ROW
  EXECUTE FUNCTION detach_completed_upload_attempts_before_video_delete();
