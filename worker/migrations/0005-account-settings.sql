-- Account settings, second factors, and a password hash that can get stronger.
--
-- One migration for both halves of the work, so production takes one step
-- rather than two. Everything is additive with a default except the token
-- table, which is rebuilt because SQLite cannot alter a CHECK constraint.
--
-- Apply BEFORE deploying the worker that reads these.
--
--   cd worker
--   npx wrangler d1 execute nexus-orders --remote --file=migrations/0005-account-settings.sql
--   npx wrangler d1 execute nexus-orders-staging --remote --file=migrations/0005-account-settings.sql

-- Where a requested new address waits until its owner proves they read it. The
-- account keeps working on the old address the whole time.
ALTER TABLE users ADD COLUMN pending_email TEXT;

/*
 * How many chained PBKDF2 passes this row's hash took.
 *
 * Workers refuses more than 100,000 iterations in one call, which is below
 * OWASP's figure for this algorithm. Chaining the output of one derivation
 * into the next multiplies the work an attacker must repeat per guess, so six
 * passes is 600,000 effective iterations — measured at 139ms, against a 30s
 * CPU budget.
 *
 * Existing rows default to 1, because that is what they actually are. They are
 * re-hashed at the stronger setting the next time their owner signs in, rather
 * than being locked out by a change they did not ask for.
 */
ALTER TABLE users ADD COLUMN kdf_rounds INTEGER NOT NULL DEFAULT 1;

-- Base32, as the authenticator app expects it. NULL means no second factor.
ALTER TABLE users ADD COLUMN totp_secret TEXT;
-- Set only once a code from the app has been checked. A secret that was
-- generated but never confirmed must not lock anybody out of their account.
ALTER TABLE users ADD COLUMN totp_confirmed_at TEXT;

/*
 * The way back in when the phone is gone.
 *
 * Without these, turning on a second factor is a way to lose an account. Each
 * is stored as a hash and spent on use, same as every other one-shot credential
 * here.
 */
CREATE TABLE IF NOT EXISTS recovery_codes (
  code_hash  TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  used_at    TEXT
);

CREATE INDEX IF NOT EXISTS recovery_codes_user_idx ON recovery_codes(user_id);

-- Rebuilt for the new purpose. Rows carry across unchanged.
CREATE TABLE email_tokens_new (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('verify','reset','email_change')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL,
  used_at     TEXT
);

INSERT INTO email_tokens_new (token_hash, user_id, purpose, created_at, expires_at, used_at)
  SELECT token_hash, user_id, purpose, created_at, expires_at, used_at FROM email_tokens;

DROP TABLE email_tokens;
ALTER TABLE email_tokens_new RENAME TO email_tokens;

CREATE INDEX IF NOT EXISTS email_tokens_user_idx ON email_tokens(user_id);
CREATE INDEX IF NOT EXISTS email_tokens_expiry_idx ON email_tokens(expires_at);
