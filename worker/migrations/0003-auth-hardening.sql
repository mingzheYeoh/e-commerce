-- Email verification and per-account guessing backoff.
--
-- Additive with defaults, so the worker running in production when this lands
-- keeps working untouched. Apply BEFORE deploying the worker that reads these,
-- never after.
--
--   cd worker
--   npx wrangler d1 execute nexus-orders --remote --file=migrations/0003-auth-hardening.sql
--   npx wrangler d1 execute nexus-orders-staging --remote --file=migrations/0003-auth-hardening.sql

-- Per-account backoff, which catches what a per-IP limit cannot see: a
-- thousand machines taking turns on one account, none of them often enough to
-- trip a limit of their own.
ALTER TABLE users ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0;

-- A timestamp, not a boolean. "Locked" with no end is a way for a stranger to
-- deny a real customer their account by guessing wrong five times.
ALTER TABLE users ADD COLUMN locked_until TEXT;

-- NULL means the address was typed but never proven. Existing accounts predate
-- verification entirely, so they are backfilled as verified below rather than
-- being locked out by a feature that did not exist when they signed up.
ALTER TABLE users ADD COLUMN email_verified_at TEXT;

UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL;

CREATE TABLE IF NOT EXISTS email_tokens (
  -- The SHA-256 of the token in the link, never the token. Same reasoning as
  -- the sessions table: a copy of this is a list of hashes, not a set of keys.
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('verify')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL,
  -- Single use. Set on redemption so a link forwarded, logged by a mail
  -- gateway or left in a browser history cannot be replayed.
  used_at     TEXT
);

CREATE INDEX IF NOT EXISTS email_tokens_user_idx ON email_tokens(user_id);
