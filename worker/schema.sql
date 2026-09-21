-- Orders placed through the demo checkout.
--
-- Money is stored in integer cents, matching the cart store. A REAL column for
-- currency would reintroduce exactly the float drift the rest of the project
-- avoids: 899.95 * 3 is 2699.8500000000004.
CREATE TABLE IF NOT EXISTS orders (
  id            TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  email         TEXT NOT NULL,
  ship_name     TEXT NOT NULL,
  ship_phone    TEXT NOT NULL DEFAULT '',
  -- ISO 3166-1 alpha-2. Decides which subdivisions are legal, what a postcode
  -- looks like, and which tax was charged — so it is stored, not inferred.
  ship_country  TEXT NOT NULL DEFAULT 'US',
  ship_line1    TEXT NOT NULL,
  ship_line2    TEXT NOT NULL DEFAULT '',
  ship_city     TEXT NOT NULL,
  -- Empty for countries that have none, which is why there is no NOT NULL
  -- length check hiding in here.
  ship_state    TEXT NOT NULL,
  ship_postal   TEXT NOT NULL,
  method        TEXT NOT NULL CHECK (method IN ('standard','express','overnight')),
  currency      TEXT NOT NULL DEFAULT 'USD',
  subtotal_cents INTEGER NOT NULL,
  shipping_cents INTEGER NOT NULL,
  tax_cents      INTEGER NOT NULL,
  total_cents    INTEGER NOT NULL,
  -- The simulated gateway's outcome, kept so a declined attempt is auditable
  -- rather than silently absent.
  payment_status TEXT NOT NULL CHECK (payment_status IN ('succeeded','card_declined','insufficient_funds','expired_card')),
  -- Set from the session cookie at checkout, never from the payload. An order
  -- placed signed-out stays unlinked forever: matching on email later would
  -- hand anyone who registers an address a stranger's order history.
  user_id       TEXT
);

CREATE TABLE IF NOT EXISTS order_lines (
  order_id      TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sku           TEXT NOT NULL,
  title         TEXT NOT NULL,
  qty           INTEGER NOT NULL CHECK (qty > 0),
  -- Frozen at the moment of purchase. Reading today's price back from the
  -- catalogue would rewrite history every time a price changes.
  unit_price_cents INTEGER NOT NULL,
  -- The finish chosen, validated against that product's colourways before it
  -- got here. Empty string rather than NULL because it is part of the key, and
  -- SQLite treats NULLs in a primary key as distinct from one another — which
  -- would let the same line be inserted twice.
  variant       TEXT NOT NULL DEFAULT '',
  -- Two finishes of one product are two lines. Keyed on (order_id, sku) alone,
  -- ordering a black one and a silver one loses the second.
  PRIMARY KEY (order_id, sku, variant)
);

-- Accounts. What one buys is narrow on purpose: the orders you placed while
-- signed in, on any device. The cart and the comparison stay on the device.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  -- Lower-cased by the application rather than by a collation, so one address
  -- cannot become two accounts.
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  -- PBKDF2-HMAC-SHA256, base64, per-user salt.
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  iterations    INTEGER NOT NULL,
  -- Chained passes of PBKDF2. The runtime caps one call at 100,000 iterations,
  -- so six passes is how 600,000 is reached. Stored per row, so it can be
  -- raised again and old rows re-hashed on next sign-in rather than locked out.
  kdf_rounds    INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  -- NULL means the address was typed but never proven.
  email_verified_at TEXT,
  -- A requested new address, waiting for its owner to prove they read it. The
  -- account keeps working on the old one until they do.
  pending_email TEXT,
  -- Per-account guessing backoff: what a per-IP limit cannot see.
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  -- A timestamp, not a boolean. A lock with no end is a way for a stranger to
  -- take an account away from its owner by guessing wrong five times.
  locked_until  TEXT,
  -- Base32, as the authenticator app expects it. NULL means no second factor.
  totp_secret   TEXT,
  -- Set only once a code has been checked: a secret that was generated and
  -- never confirmed must not lock anybody out.
  totp_confirmed_at TEXT
);

CREATE TABLE IF NOT EXISTS email_tokens (
  -- The SHA-256 of the token in the link, never the token itself.
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('verify','reset','email_change')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL,
  -- Single use, so a link forwarded, logged by a mail gateway or left in a
  -- browser history cannot be replayed.
  used_at     TEXT
);

-- The way back in when the phone is gone. Without these, turning on a second
-- factor is a way to lose an account.
CREATE TABLE IF NOT EXISTS recovery_codes (
  code_hash  TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  used_at    TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  -- The SHA-256 of the cookie, never the cookie. A dump of this table is a
  -- list of hashes rather than a set of working keys.
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS orders_email_idx ON orders(email);
CREATE INDEX IF NOT EXISTS orders_created_idx ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS orders_user_idx ON orders(user_id);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS email_tokens_user_idx ON email_tokens(user_id);
CREATE INDEX IF NOT EXISTS recovery_codes_user_idx ON recovery_codes(user_id);
-- Read by the nightly sweep. Without them it is a full scan of every session
-- and link ever issued.
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS email_tokens_expiry_idx ON email_tokens(expires_at);

-- ------------------------------------------------------------------ tenancy

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
  price_minor  INTEGER NOT NULL CHECK (typeof(price_minor) = 'integer' AND price_minor >= 0),
  currency     TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('draft','published','archived')),
  stock_count  INTEGER NOT NULL DEFAULT 0 CHECK (typeof(stock_count) = 'integer' AND stock_count >= 0),
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
