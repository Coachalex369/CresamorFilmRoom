-- Team-scoped Messages: closes a real access gap where every user in the
-- app was a participant in the same single conversation, regardless of
-- team (see auth.js's now-removed auto-join-on-register). Going forward,
-- one category='team' conversation exists per team, and access to it is
-- derived LIVE from active team_members (see permissions.js's
-- canAccessConversation), not from this table's static rows --
-- conversation_participants is retained only for last_read_at/unread
-- bookkeeping, never the authorization boundary, so a stale or missing
-- row can no longer leak OR block access.
--
-- Conservative on existing data: nothing is deleted, nothing is
-- redistributed by guesswork. Every existing conversation with a real
-- team_id keeps its message history exactly as-is -- only its VISIBILITY
-- now correctly narrows to that team's live membership going forward,
-- instead of remaining visible to every user in the system the way it
-- was under the old participant-table-only check. Concretely: the one
-- legacy conversation created by migration 004's backfill already has a
-- real team_id and category='team' -- it is left completely untouched by
-- this migration (the WHERE NOT EXISTS below skips it) and simply
-- becomes that one team's conversation going forward.

-- One conversation per team that doesn't already have one.
INSERT INTO conversations (team_id, category, title)
SELECT teams.id, 'team', teams.name || ' Team Chat'
FROM teams
WHERE NOT EXISTS (
  SELECT 1 FROM conversations
  WHERE conversations.team_id = teams.id AND conversations.category = 'team'
);

-- Seed conversation_participants for every currently-active team member
-- against their team's conversation -- read-state bookkeeping only, not
-- access (canAccessConversation checks team_members directly for a
-- team-scoped conversation, not this table).
INSERT INTO conversation_participants (conversation_id, user_id)
SELECT conversations.id, team_members.user_id
FROM team_members
JOIN conversations
  ON conversations.team_id = team_members.team_id AND conversations.category = 'team'
WHERE team_members.revoked_at IS NULL
ON CONFLICT (conversation_id, user_id) DO NOTHING;
