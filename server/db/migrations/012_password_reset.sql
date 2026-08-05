-- Teams MVP — forgot-password / reset-password flow. No password-reset
-- mechanism of any kind existed anywhere in this codebase before this.
--
-- Same token_hash-not-raw-token discipline as invitations. Short expiry
-- (1 hour, enforced in server/routes/auth.js, not here) since unlike an
-- invitation this token grants direct account access once used.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id ON password_reset_tokens(user_id);
