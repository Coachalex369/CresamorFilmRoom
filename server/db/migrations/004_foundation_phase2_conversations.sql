-- Foundation Sprint — Phase 2: Conversation architecture.
--
-- Replaces the flat Sprint 3 `messages` table (no conversation concept) with
-- Conversations -> Conversation Participants -> Messages, per the sprint
-- brief. The MVP UI still exposes exactly one thread — this migration
-- creates one default conversation and moves every existing message into
-- it, so nothing is lost and the feature keeps working identically from a
-- user's point of view while the backend is now built correctly.
--
-- Additive only, same discipline as every prior migration: no DROP. The old
-- flat GET/POST /api/messages endpoints are being retired in this same
-- phase (see server/app.js) since keeping both the flat and conversation-
-- scoped paths alive would be exactly the "parallel system" the brief says
-- not to build — but the `messages` table itself is preserved and extended,
-- not replaced by a new table.

CREATE TABLE IF NOT EXISTS conversations (
  id SERIAL PRIMARY KEY,
  team_id INTEGER REFERENCES teams(id),
  category TEXT CHECK (category IN ('coach', 'parent', 'team', 'athlete', 'direct')),
  title TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS conversation_participants (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER REFERENCES conversations(id),
  user_id INTEGER REFERENCES users(id),
  last_read_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(conversation_id, user_id)
);

ALTER TABLE messages ADD COLUMN IF NOT EXISTS conversation_id INTEGER REFERENCES conversations(id);

CREATE INDEX IF NOT EXISTS idx_conversations_team_id ON conversations(team_id);
CREATE INDEX IF NOT EXISTS idx_conversation_participants_conversation_id ON conversation_participants(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversation_participants_user_id ON conversation_participants(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);

-- ---------- Backfill: one default conversation, every existing message
-- ---------- moved into it, every existing user added as a participant
-- ---------- (matches current behavior: everyone sees the one thread).

INSERT INTO conversations (team_id, category, title)
SELECT
  (SELECT id FROM teams ORDER BY id LIMIT 1),
  'team',
  'Team Messages'
WHERE NOT EXISTS (SELECT 1 FROM conversations);

UPDATE messages
SET conversation_id = (SELECT id FROM conversations ORDER BY id LIMIT 1)
WHERE conversation_id IS NULL;

INSERT INTO conversation_participants (conversation_id, user_id)
SELECT (SELECT id FROM conversations ORDER BY id LIMIT 1), u.id
FROM users u
ON CONFLICT (conversation_id, user_id) DO NOTHING;

-- Now that every existing row has a conversation_id, require it going
-- forward — new messages must belong to a real conversation.
ALTER TABLE messages ALTER COLUMN conversation_id SET NOT NULL;
