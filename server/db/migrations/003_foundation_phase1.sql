-- Foundation Sprint — Phase 1: Database cleanup, Schools, Teams, FK
-- relationships, Indexes, Profile schema expansion.
--
-- Additive only, same discipline as every prior migration in this
-- directory: no DROP, no data loss. The legacy `users.team` free-text
-- column is kept as a deprecated fallback, not removed — see CLAUDE.md
-- for the deprecation plan.

-- ---------- Organization -> School -> Team hierarchy ----------

CREATE TABLE IF NOT EXISTS organizations (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS schools (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER REFERENCES organizations(id),
  name TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS teams (
  id SERIAL PRIMARY KEY,
  school_id INTEGER REFERENCES schools(id),
  name TEXT NOT NULL,
  sport TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Many-to-many team membership (an athlete or coach may belong to more than
-- one team — JV + varsity, multi-sport, an assistant coaching two teams).
-- This is the single source of truth for "who's on what team"; there is
-- deliberately no denormalized users.primary_team_id column duplicating it
-- (see the Phase 1 report for why — avoids a second place that can drift
-- out of sync with this table).
CREATE TABLE IF NOT EXISTS team_members (
  id SERIAL PRIMARY KEY,
  team_id INTEGER REFERENCES teams(id),
  user_id INTEGER REFERENCES users(id),
  role_on_team TEXT,
  is_primary BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(team_id, user_id)
);

-- ---------- Profile schema expansion ----------

ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS height_inches INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS weight_lbs INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS primary_position TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS goals TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS accomplishments TEXT;
-- Social/recruiting links: deliberately JSONB, not one column per platform.
-- Shape: [{ "platform": "instagram", "url": "..." }, ...]
ALTER TABLE users ADD COLUMN IF NOT EXISTS social_links JSONB DEFAULT '[]'::jsonb;

-- ---------- Video <-> team/type linkage ----------
-- Real columns replacing Sprint 1's documented workaround (film_type/team
-- folded into the video title string because no columns existed yet).

ALTER TABLE videos ADD COLUMN IF NOT EXISTS team_id INTEGER REFERENCES teams(id);
ALTER TABLE videos ADD COLUMN IF NOT EXISTS film_type TEXT CHECK (film_type IN ('individual', 'team'));

-- ---------- Indexes on every foreign key column ----------
-- Postgres does not auto-index FK columns (only PKs/unique constraints).
-- These were missing since the original schema — see the Sprint 3
-- architecture review, Priority 2.

CREATE INDEX IF NOT EXISTS idx_clips_video_id ON clips(video_id);
CREATE INDEX IF NOT EXISTS idx_clips_user_id ON clips(user_id);
CREATE INDEX IF NOT EXISTS idx_videos_uploaded_by ON videos(uploaded_by);
CREATE INDEX IF NOT EXISTS idx_videos_team_id ON videos(team_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender_id ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_schools_organization_id ON schools(organization_id);
CREATE INDEX IF NOT EXISTS idx_teams_school_id ON teams(school_id);
CREATE INDEX IF NOT EXISTS idx_team_members_team_id ON team_members(team_id);
CREATE INDEX IF NOT EXISTS idx_team_members_user_id ON team_members(user_id);

-- ---------- Backfill ----------
-- One default organization/school so the hierarchy has somewhere real to
-- attach to rather than sitting empty. Real org/school management (letting
-- a customer create their own) is future work, out of scope for Phase 1.

INSERT INTO organizations (name)
SELECT 'Cresamor'
WHERE NOT EXISTS (SELECT 1 FROM organizations);

INSERT INTO schools (organization_id, name)
SELECT o.id, 'Cresamor Athletics'
FROM organizations o
WHERE o.name = 'Cresamor'
  AND NOT EXISTS (SELECT 1 FROM schools);

-- One real teams row per distinct legacy users.team text value, with a
-- best-effort sport guess from the name (informational only, safe to
-- correct manually later).
INSERT INTO teams (school_id, name, sport)
SELECT
  (SELECT id FROM schools ORDER BY id LIMIT 1),
  dt.team,
  CASE
    WHEN dt.team ILIKE '%wrestling%' THEN 'wrestling'
    WHEN dt.team ILIKE '%football%' THEN 'football'
    ELSE NULL
  END
FROM (SELECT DISTINCT team FROM users WHERE team IS NOT NULL AND team <> '') AS dt
WHERE NOT EXISTS (SELECT 1 FROM teams t WHERE t.name = dt.team);

-- Link every user who had a legacy team value to their new team_members row.
INSERT INTO team_members (team_id, user_id, role_on_team, is_primary)
SELECT t.id, u.id, u.role, true
FROM users u
JOIN teams t ON t.name = u.team
WHERE u.team IS NOT NULL AND u.team <> ''
ON CONFLICT (team_id, user_id) DO NOTHING;
