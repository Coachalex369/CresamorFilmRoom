-- Resumable, direct-to-R2 mobile uploads — tracks one multipart upload
-- session per attempt. Additive only, same discipline as every prior
-- migration: no DROP, no data loss, safe to re-run.
--
-- Numbered 019, not 017: server/db/migrations/017 and 018 are already
-- reserved on feature/direct-messaging (017_direct_messaging.sql) and
-- feature/roster-profiles (018_roster_profiles.sql) respectively, neither
-- of which this branch (based on main, pre-those-features) has locally.
-- Checked every branch's migration history before picking this number so
-- whichever merge order actually happens doesn't collide.
--
-- videos itself needs zero schema changes: a completed session INSERTs a
-- videos row shaped identically to today's POST /api/upload-video (see
-- server/routes/videos.js) — video_id here is just the pointer to it,
-- set once, at completion.
--
-- session_id is a server-generated UUID and the ONLY identifier ever
-- exposed to the client / used in route paths (server/routes/videoUploads.js).
-- r2_upload_id (the actual R2/S3 multipart UploadId) is never returned to
-- the client and never appears in a URL — R2/S3 upload IDs are opaque and
-- may contain URL-significant characters, and there's no reason for a
-- client to ever see or need R2's own identifier when it has its own safe
-- one. r2_upload_id stays UNIQUE for the same idempotency-anchor reasoning
-- session_id has -- either one alone would do; both are kept unique since
-- both are look-up keys in practice (session_id from routes, r2_upload_id
-- from the storage layer).
--
-- team_id is nullable at the SCHEMA level (matches videos.team_id's own
-- column shape) but the route enforces it as effectively required for
-- beta: server/routes/videoUploads.js's initiate handler 400s on a
-- missing/null team_id outright -- unassigned multipart uploads aren't
-- authorized yet, unlike the legacy POST /api/upload-video route, which
-- still accepts no team_id at all (preserved there for parity, not fixed
-- as a side effect of this feature). A personal/unassigned large-upload
-- destination is real future work, not something this endpoint quietly
-- allows by omission. NOT events.team_id, which is NOT NULL at the schema
-- level for a different reason (see 016_schedule.sql) -- kept nullable
-- here rather than a NOT NULL constraint so a future authorized unassigned
-- destination doesn't need a schema migration to enable, only a route
-- change.
--
-- Every team_id this route DOES accept is authorization-checked at
-- initiate time (canUploadToTeam() in permissions.js — active
-- team_members row with role_on_team IN ('coach', 'assistant_coach')
-- specifically; a 'parent' team-role or an unrelated user cannot target a
-- team's Film Room by ID through this endpoint, and team_id: null cannot
-- be used to bypass the check since it's rejected before the check would
-- even run). Parent uploads are meant for a separate future "Team
-- Highlights" destination, not this endpoint.
--
-- updated_at is the sweep's (uploadSweep.js) activity signal, not
-- created_at -- every presign/status call bumps it, so a legitimate
-- hour-plus upload or a next-day resume that's still actively progressing
-- is never swept just because it started a while ago.
--
-- last_modified is the client-reported File.lastModified (ms epoch) --
-- part of the {name, size, type, lastModified} fingerprint the client
-- re-verifies against on resume, since a mobile browser can't retain a
-- File handle across an app restart and the user has to re-select the
-- file by hand.

CREATE TABLE IF NOT EXISTS video_uploads (
  id SERIAL PRIMARY KEY,
  session_id UUID NOT NULL UNIQUE,
  r2_upload_id TEXT NOT NULL UNIQUE,
  storage_key TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  team_id INTEGER REFERENCES teams(id),
  title TEXT NOT NULL,
  content_type TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_size BIGINT NOT NULL,
  last_modified BIGINT,
  part_size INTEGER NOT NULL,
  part_count INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (
    status IN ('in_progress', 'completed', 'aborted')
  ),
  video_id INTEGER REFERENCES videos(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Ownership check on every non-initiate endpoint (presign/complete/abort/
-- status) is "WHERE session_id = $1 AND user_id = $2" -- this is the index
-- that check actually runs against.
CREATE INDEX IF NOT EXISTS idx_video_uploads_session_id ON video_uploads(session_id);

-- The orphan sweep's query shape (server/services/uploadSweep.js):
-- WHERE status = 'in_progress' AND updated_at < now() - interval.
-- Deliberately updated_at, not created_at -- see the file header above.
CREATE INDEX IF NOT EXISTS idx_video_uploads_status_updated_at ON video_uploads(status, updated_at);
