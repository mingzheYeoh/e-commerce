-- International addresses, and accounts.
--
-- Every column added here is additive with a default, which is what makes the
-- ordering safe: the worker running in production when this lands never
-- mentions any of them and keeps inserting correctly. Apply this BEFORE
-- deploying the worker that writes them, never after.
--
--   cd worker
--   npx wrangler d1 execute nexus-orders --remote --file=migrations/0002-addresses-and-accounts.sql
--   npx wrangler d1 execute nexus-orders-staging --remote --file=migrations/0002-addresses-and-accounts.sql

-- Existing rows are US orders — that was the only address the form could
-- produce — so the default states a fact rather than papering over one.
ALTER TABLE orders ADD COLUMN ship_country TEXT NOT NULL DEFAULT 'US';
ALTER TABLE orders ADD COLUMN ship_line2   TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN ship_phone   TEXT NOT NULL DEFAULT '';

-- Nullable, and deliberately not a foreign key. An order is a financial record
-- that has to outlive the account that placed it; ON DELETE CASCADE here would
-- mean closing an account erases the evidence of what was bought, and
-- ON DELETE SET NULL is what a bare column does anyway.
ALTER TABLE orders ADD COLUMN user_id TEXT;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  -- Stored already lower-cased by the application rather than relying on a
  -- collation, so "Ada@x.com" and "ada@x.com" cannot become two accounts.
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  -- PBKDF2-HMAC-SHA256, base64. The salt is per user; the iteration count is
  -- stored so it can be raised later and old rows re-hashed on next sign-in
  -- instead of everyone being locked out at once.
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  iterations    INTEGER NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  -- The SHA-256 of the cookie value, never the value. A copy of this table is
  -- then a list of hashes rather than a set of working session keys.
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS orders_user_idx ON orders(user_id);
