-- Teams MVP — foundational schema piece needed by both the revoke-member
-- feature and the invitations system below.
--
-- revoked_at/revoked_by: a team_members row is never deleted when a coach
-- removes someone from a team (the account and its personal data must be
-- preserved, per the Teams MVP spec) -- it's soft-disabled instead.
-- revoked_at IS NULL means active; permission checks (canAccessTeam) are
-- updated to require this. Re-inviting or re-accepting simply clears
-- these two columns rather than erroring or duplicating a row.
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS revoked_by INTEGER REFERENCES users(id);

-- New account-role value for an invited Assistant Coach. Deliberately NOT
-- reusing 'coach': every existing permission check (canAccessTeam,
-- canManageTeamMembership, canDeleteVideo) treats role = 'coach' as an
-- unconditional, system-wide superset -- an assistant coach's access must
-- instead be governed purely by their (revocable) team_members row, or
-- revoking them would not actually block anything. 'assistant_coach'
-- intentionally matches none of those existing role === 'coach' checks.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('coach', 'athlete', 'parent', 'assistant_coach'));
