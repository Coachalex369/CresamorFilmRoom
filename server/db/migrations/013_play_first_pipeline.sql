-- Play-First Video Pipeline: replaces the size-based "deferred" dead end
-- with a codec-based classifier (playable / remux / transcode_needed).
-- 'deferred' stays a valid status (historical rows, e.g. video 274, are
-- migrated forward by server/scripts/reclassifyDeferredVideos.js rather
-- than by this migration) — the new pipeline just never writes it again.
ALTER TABLE videos DROP CONSTRAINT IF EXISTS videos_processing_status_check;
ALTER TABLE videos ADD CONSTRAINT videos_processing_status_check CHECK (
  processing_status IN (
    'uploading','processing','queued','converting','ready','failed','deferred',
    'classifying','remuxing','transcode_paused'
  )
);

-- Populated once per video by classifyVideo() and reused thereafter — not
-- re-probed on every request, unlike the existing per-request
-- available/needs_conversion computation in withPlaybackStatus().
ALTER TABLE videos ADD COLUMN IF NOT EXISTS video_codec TEXT;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS audio_codec TEXT;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS container TEXT;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS classification TEXT; -- 'playable' | 'remux' | 'transcode_needed'
