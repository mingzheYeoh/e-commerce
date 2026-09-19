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
  PRIMARY KEY (order_id, sku)
);

CREATE INDEX IF NOT EXISTS orders_email_idx ON orders(email);
CREATE INDEX IF NOT EXISTS orders_created_idx ON orders(created_at DESC);
