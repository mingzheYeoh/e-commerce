-- Password reset, and a way out of an unverified account.
--
-- `email_tokens.purpose` has a CHECK constraint and SQLite cannot alter one,
-- so the table is rebuilt. Rows carry across unchanged; the only difference is
-- that 'reset' is now a legal purpose.
--
-- Apply BEFORE deploying the worker that issues reset tokens — an insert with
-- purpose='reset' against the old constraint fails, and the shopper sees a
-- reset that silently never arrives.
--
--   cd worker
--   npx wrangler d1 execute nexus-orders --remote --file=migrations/0004-recovery-tokens.sql
--   npx wrangler d1 execute nexus-orders-staging --remote --file=migrations/0004-recovery-tokens.sql

CREATE TABLE email_tokens_new (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('verify','reset')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL,
  used_at     TEXT
);

INSERT INTO email_tokens_new (token_hash, user_id, purpose, created_at, expires_at, used_at)
  SELECT token_hash, user_id, purpose, created_at, expires_at, used_at FROM email_tokens;

DROP TABLE email_tokens;
ALTER TABLE email_tokens_new RENAME TO email_tokens;

CREATE INDEX IF NOT EXISTS email_tokens_user_idx ON email_tokens(user_id);

-- The nightly sweep reads these two columns to find what has aged out. Without
-- them it is a full scan of every session ever issued.
CREATE INDEX IF NOT EXISTS email_tokens_expiry_idx ON email_tokens(expires_at);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
