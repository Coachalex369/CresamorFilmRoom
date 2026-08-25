-- Schedule feature — Foundation for Cresamor's single source of truth for
-- team events. Additive only, same discipline as every prior migration:
-- no DROP, no data loss. This is a genuinely greenfield table -- Calendar/
-- Home Events have only ever been client-side mock data
-- (mockData.js's MOCK_EVENTS), so there is nothing to reconcile or
-- migrate from.
--
-- team_id is deliberately NOT NULL -- unlike videos.team_id, there is no
-- "unassigned" event concept. An event always belongs to exactly one
-- team; this is what makes "never trust a client-supplied team ID" a
-- clean, unambiguous rule everywhere in the API (server/routes/schedule.js)
-- rather than needing a null-team-id special case the way videos.js does.
--
-- event_type is deliberately sport-neutral (practice/competition/meeting/
-- team_event/other) -- a sport-specific concept like a wrestling weight
-- certification is `event_type='team_event', title='Weight Certification'`,
-- not its own structural type. Widening this list later is a one-line
-- additive DROP/ADD CONSTRAINT, same pattern as migrations 010/015.
--
-- status='canceled' is a soft state, not a delete -- matches this
-- project's existing preference for soft-disable over destructive delete
-- (team_members.revoked_at, invitations.status). A genuinely mistaken
-- event still gets a real DELETE (see server/routes/schedule.js) --
-- cancel and delete are deliberately different operations with different
-- destructiveness, not two names for the same thing.
--
-- source exists now (manual/imported) specifically so the future
-- document-import milestone has somewhere to land without a later
-- migration -- 'imported' is not used or reachable by any code in this
-- branch; import staging tables are explicitly NOT created here (see
-- CLAUDE.md/RELEASE_NOTES.md for the deferred design).

CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  event_type TEXT NOT NULL CHECK (
    event_type IN ('practice', 'competition', 'meeting', 'team_event', 'other')
  ),
  title TEXT NOT NULL,
  description TEXT,
  location TEXT,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'canceled')),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'imported')),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- team_id alone (roster-style lookups), starts_at alone (Home's
-- cross-team upcoming-events query, which filters by a set of team_ids
-- but sorts/limits globally by starts_at), and the composite (the
-- Calendar/Agenda per-team date-range query, this table's most frequent
-- access pattern) all get their own index rather than relying on one to
-- serve every query shape.
CREATE INDEX IF NOT EXISTS idx_events_team_id ON events(team_id);
CREATE INDEX IF NOT EXISTS idx_events_starts_at ON events(starts_at);
CREATE INDEX IF NOT EXISTS idx_events_team_starts_at ON events(team_id, starts_at);
