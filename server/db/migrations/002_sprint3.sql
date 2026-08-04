-- Sprint 3: Cross-Device Persistence & UX Reliability
-- Additive only — no DROP statements. Safe to run against the live database.
-- Unlike server/db/schema.sql (which DROPs and recreates everything), this
-- migration only adds columns/tables and never touches existing data.

-- Profile fields (previously localStorage-only, see client/home.js)
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS school TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS team TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS graduation_year INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_picture_url TEXT;

-- Parent account type
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('coach', 'athlete', 'parent'));

-- Real persistence for the existing single shared Team Messages thread
-- (previously a hardcoded, non-persisted DOM thread — see client/index.html
-- and the old messageForm handler in client/app.js). Deliberately NOT a
-- multi-conversation schema — that's still deferred future work.
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  sender_id INTEGER REFERENCES users(id),
  username TEXT NOT NULL,
  role TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Video processing pipeline scaffolding (item 7) — no real processing yet,
-- see server/services/videoProcessing.js
ALTER TABLE videos ADD COLUMN IF NOT EXISTS processing_status TEXT DEFAULT 'ready';
