-- Teams MVP — invitation system. No prior invitation concept exists
-- anywhere in this codebase; this is entirely new.
--
-- token_hash, not the raw token: the raw token only ever lives in the
-- invite link itself (email body / SMS body / manually-copied URL) --
-- never stored, never logged. Accept-time validation hashes the incoming
-- token and looks up by hash, same discipline as password hashing.
--
-- Each invitation is single-use (status flips to 'accepted') and
-- single-purpose (one team, one role, one destination) but a coach can
-- send unlimited fresh invitations to the same destination -- each gets
-- its own row/token. Re-inviting the same (team_id, destination,
-- role_on_team) supersedes prior pending invitations for that exact
-- combination (see invitations.js's createInvitation) rather than
-- leaving multiple simultaneously-valid links outstanding.
CREATE TABLE IF NOT EXISTS invitations (
  id SERIAL PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  invited_by INTEGER NOT NULL REFERENCES users(id),
  role_on_team TEXT NOT NULL CHECK (role_on_team IN ('athlete', 'parent', 'assistant_coach')),
  destination_type TEXT NOT NULL CHECK (destination_type IN ('email', 'phone')),
  destination TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  accepted_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invitations_team_id ON invitations(team_id);
CREATE INDEX IF NOT EXISTS idx_invitations_destination ON invitations(destination);
CREATE INDEX IF NOT EXISTS idx_invitations_token_hash ON invitations(token_hash);
