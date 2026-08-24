-- Platform Admin: a persistent, DB-backed designation, deliberately
-- separate from team_members.role_on_team. A boolean on users, not a
-- hardcoded email allow-list and not a separate table -- there is exactly
-- one admin concept needed right now (can this account issue Coach-level
-- invitations, and manage teams/users for beta support), it's account-wide
-- not per-team, and there is no self-service path to become one. Set by
-- hand via psql after this migration runs, same convention this project
-- already uses for applying migrations themselves.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_platform_admin BOOLEAN NOT NULL DEFAULT false;

-- Widen the invitation role constraint to permit 'coach'. Additive only --
-- existing rows are unaffected (a CHECK widening never invalidates data
-- that already satisfied the narrower constraint). WHO may actually send
-- a coach-level invitation is enforced in application code
-- (routes/invitations.js: requires req.user.is_platform_admin), not by
-- this constraint -- this only makes the value legal to store, matching
-- how 'athlete'/'parent'/'assistant_coach' already work.
ALTER TABLE invitations DROP CONSTRAINT IF EXISTS invitations_role_on_team_check;
ALTER TABLE invitations ADD CONSTRAINT invitations_role_on_team_check CHECK (role_on_team IN ('athlete', 'parent', 'assistant_coach', 'coach'));
