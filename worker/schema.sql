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
  ship_line1    TEXT NOT NULL,
  ship_city     TEXT NOT NULL,
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
  payment_status TEXT NOT NULL CHECK (payment_status IN ('succeeded','card_declined','insufficient_funds','expired_card'))
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

CREATE INDEX IF NOT EXISTS orders_email_idx ON orders(email);
CREATE INDEX IF NOT EXISTS orders_created_idx ON orders(created_at DESC);
