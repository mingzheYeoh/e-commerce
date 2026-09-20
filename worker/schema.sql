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
  -- PBKDF2-HMAC-SHA256, base64, per-user salt. The iteration count is stored
  -- so it can be raised later without locking everyone out at once.
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  iterations    INTEGER NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
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
