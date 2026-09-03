-- One-Button Highlight release: POST /api/clips had no dedup mechanism —
-- a rapid double-tap or a client-side retry could create two identical
-- clip rows for the same user/video/range. client_request_id lets the
-- client send a stable id per highlight attempt (generated once, at
-- Start Highlight); the route upserts on (user_id, client_request_id)
-- instead of blindly inserting, so a duplicate submission returns the
-- original row instead of creating a second one. Nullable and NOT
-- unique on its own — only unique per user, and only enforced for rows
-- that actually set it, so every existing clip (and any future caller
-- that doesn't send one) is untouched.
ALTER TABLE clips ADD COLUMN IF NOT EXISTS client_request_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS clips_user_client_request_id_key
  ON clips (user_id, client_request_id)
  WHERE client_request_id IS NOT NULL;
