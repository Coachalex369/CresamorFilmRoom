-- Direct Messaging — Phase 1 backend/schema.
--
-- Additive only, same discipline as every prior migration: no DROP, no
-- data loss, existing conversations/messages/team_members rows untouched.
--
-- parent_athlete_links: the one piece of relationship data that genuinely
-- does not exist anywhere in this schema today (see ARCHITECTURE.md's
-- "No parent-child linking table exists" and the Direct Messaging
-- architecture proposal). Same soft-revocation shape as team_members
-- (revoked_at IS NULL = active) for the same reason: DM eligibility
-- derived from this table must be able to be live-reevaluated and
-- instantly cut off, not just deleted and lost. This table starts and
-- stays EMPTY in this branch — populating it (an athlete/parent linking
-- UI) is Roster Profiles' job, not Direct Messaging's. Until it's
-- populated, every parent has zero linked athletes, so parent-side DM
-- eligibility is correctly empty rather than broadly (unsafely) open.
CREATE TABLE IF NOT EXISTS parent_athlete_links (
  id SERIAL PRIMARY KEY,
  parent_user_id INTEGER NOT NULL REFERENCES users(id),
  athlete_user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  created_by INTEGER REFERENCES users(id),
  revoked_at TIMESTAMPTZ,
  revoked_by INTEGER REFERENCES users(id),
  UNIQUE(parent_user_id, athlete_user_id)
);

CREATE INDEX IF NOT EXISTS idx_parent_athlete_links_parent ON parent_athlete_links(parent_user_id);
CREATE INDEX IF NOT EXISTS idx_parent_athlete_links_athlete ON parent_athlete_links(athlete_user_id);

-- direct_pair_key: deterministic LEAST(user_a,user_b) || '_' || GREATEST(user_a,user_b),
-- set ONLY on category='direct' conversations (NULL for every other
-- category, so the partial unique index below never constrains
-- team/legacy conversations). This is what makes "two users always
-- resolve to one canonical DM thread" a database-enforced guarantee
-- rather than an application-level convention that a race condition
-- could violate — concurrent creation attempts for the same pair collide
-- on this index, not on application logic.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS direct_pair_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_direct_pair_key
  ON conversations(direct_pair_key) WHERE category = 'direct';
