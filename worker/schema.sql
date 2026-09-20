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
