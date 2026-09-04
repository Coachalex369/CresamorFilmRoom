-- Landing page (cresamor.com), "Become an Early User" interest form.
-- Durable-first-then-email design: the row is inserted BEFORE any email
-- send is attempted, so a temporary email failure (or a future Resend
-- outage) can never lose a lead -- the two boolean flags below just
-- record what happened, they never gate whether the submission itself
-- is kept. role_or_interest is constrained to a small known set (same
-- "constrained enum where sensible" precedent as team_members.role_on_team)
-- rather than free text, since the landing form's own select only ever
-- offers these four options.
CREATE TABLE IF NOT EXISTS landing_interest_signups (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  role_or_interest TEXT NOT NULL CHECK (role_or_interest IN ('coach', 'athlete', 'parent', 'other')),
  sport TEXT,
  team_or_program TEXT,
  message TEXT,
  notification_sent BOOLEAN NOT NULL DEFAULT false,
  confirmation_sent BOOLEAN NOT NULL DEFAULT false,
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_landing_interest_signups_email ON landing_interest_signups(email);
CREATE INDEX IF NOT EXISTS idx_landing_interest_signups_created_at ON landing_interest_signups(created_at);
