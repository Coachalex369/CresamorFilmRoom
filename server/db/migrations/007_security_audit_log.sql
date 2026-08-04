-- Beta Readiness Sprint 2 — Server-Side Authentication & Authorization.
--
-- Lightweight security audit trail: login/failed-login, video deletion,
-- team membership changes (including role grants), and rejected auth
-- attempts. user_id is nullable — a failed login for an email that
-- doesn't exist, or a rejected token with no resolvable user, still gets
-- logged with user_id NULL and identifying details in metadata instead.
--
-- No retention/pruning job ships with this migration — see
-- ARCHITECTURE.md's "Security audit log" section for the documented
-- (manual, not automated) retention strategy.
--
-- Additive only, safe to run once against production, safe to re-run.

CREATE TABLE IF NOT EXISTS security_audit_log (
  id SERIAL PRIMARY KEY,
  event_type TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  ip_address TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_security_audit_log_event_type ON security_audit_log(event_type);
CREATE INDEX IF NOT EXISTS idx_security_audit_log_user_id ON security_audit_log(user_id);
