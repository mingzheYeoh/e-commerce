-- Multi-merchant tenancy: merchants, staff, the audit log and the products
-- table.
--
-- Entirely new tables, so nothing existing is touched and the running worker
-- is unaffected. Apply BEFORE deploying the worker that reads them.
--
--   cd worker
--   npx wrangler d1 execute nexus-orders --remote --file=migrations/0006-tenancy.sql
--   npx wrangler d1 execute nexus-orders-staging --remote --file=migrations/0006-tenancy.sql

-- A merchant selling through NEXUS. `status` is not decoration: a suspended
-- merchant's products leave the storefront, and their orders stay, because
-- those are transactions that happened.
CREATE TABLE IF NOT EXISTS merchants (
  id                  TEXT PRIMARY KEY,
  slug                TEXT NOT NULL UNIQUE,
  name                TEXT NOT NULL,
  -- What they price in and are paid in. Denormalised onto each product at
  -- write time, so changing it never reinterprets an existing price.
  settlement_currency TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('pending','active','suspended')),
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

/*
 * Merchant and platform staff. Deliberately NOT the customer `users` table:
 * a `role` column there would make the boundary one `if` statement living
 * beside everything else that can have a bug.
 *
 * The encoding worth arguing about is `scope`. "merchant_id IS NULL means
 * platform" reads naturally and is the shape of a privilege-escalation bug —
 * anything that writes NULL into that column hands out a platform pass. The
 * paired CHECK below means the database refuses an incoherent row, so it is
 * not something to remember to check.
 */
CREATE TABLE IF NOT EXISTS staff (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  scope         TEXT NOT NULL CHECK (scope IN ('merchant','platform')),
  merchant_id   TEXT REFERENCES merchants(id),
  -- merchant: owner | member.  platform: admin.
  -- A column rather than a second table so a read-only 'support' role later
  -- is data instead of schema.
  role          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  iterations    INTEGER NOT NULL,
  kdf_rounds    INTEGER NOT NULL DEFAULT 1,
  totp_secret   TEXT,
  totp_confirmed_at TEXT,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((scope = 'merchant' AND merchant_id IS NOT NULL)
      OR (scope = 'platform' AND merchant_id IS NULL))
);

/*
 * Who did what to whose data.
 *
 * Recorded: every write by anyone, plus every PLATFORM read of merchant-scoped
 * data. Not merchant reads of their own data — that is noise and write volume.
 *
 * Merchants can read the entries about themselves. "NEXUS support viewed your
 * orders on 21 September" is what makes this a reason to join the platform
 * rather than only the platform's own defence.
 */
CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  at          TEXT NOT NULL DEFAULT (datetime('now')),
  actor_id    TEXT NOT NULL,
  actor_scope TEXT NOT NULL CHECK (actor_scope IN ('merchant','platform')),
  -- Whose data was touched. NULL only for actions that belong to no merchant.
  merchant_id TEXT REFERENCES merchants(id),
  action      TEXT NOT NULL,
  subject     TEXT,
  detail      TEXT
);

CREATE TABLE IF NOT EXISTS products (
  id           TEXT PRIMARY KEY,
  merchant_id  TEXT NOT NULL REFERENCES merchants(id),
  sku          TEXT NOT NULL,
  title        TEXT NOT NULL,
  brand        TEXT NOT NULL,
  category     TEXT NOT NULL,
  -- Minor units of `currency`, which is copied from the merchant at write
  -- time and frozen.
  price_minor  INTEGER NOT NULL,
  currency     TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('draft','published','archived')),
  stock_count  INTEGER NOT NULL DEFAULT 0,
  -- Document-shaped and never queried by field, so JSON rather than columns.
  specs        TEXT NOT NULL DEFAULT '[]',
  colorways    TEXT NOT NULL DEFAULT '[]',
  media        TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  -- Per merchant, not global: two merchants may both sell IP18P-256.
  UNIQUE (merchant_id, sku)
);

CREATE INDEX IF NOT EXISTS products_merchant_idx ON products(merchant_id);
CREATE INDEX IF NOT EXISTS staff_merchant_idx ON staff(merchant_id);
CREATE INDEX IF NOT EXISTS audit_merchant_idx ON audit_log(merchant_id, at DESC);

-- Append-only, enforced. Verified against SQLite: both statements abort.
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT,'audit log is append-only'); END;

CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT,'audit log is append-only'); END;
