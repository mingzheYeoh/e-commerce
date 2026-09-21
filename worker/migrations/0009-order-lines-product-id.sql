-- UNIQUE (merchant_id, sku) was right, and it demoted sku from an identity to
-- an attribute. The order pipeline was keyed on it, so the key has to move.
--
-- A primary key change is a table rebuild in SQLite, not an ALTER. This whole
-- file lands through the --file import, which is all-or-nothing, so a failure
-- leaves order_lines exactly as it was.
--
-- The backfill resolves sku -> product. That is unambiguous only while sku is
-- still globally unique, which is true today and false the first time two
-- merchants list the same one. NOT NULL on product_id is what turns an
-- unresolvable row into an aborted import rather than a falsified order line.
--
--   cd worker
--   npx wrangler d1 execute nexus-orders-staging --remote --file=migrations/0009-order-lines-product-id.sql

CREATE TABLE order_lines_new (
  order_id      TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  -- The catalogue id, globally unique. sku is kept because it is what a
  -- customer reads on a receipt, but it no longer identifies anything.
  product_id    TEXT NOT NULL,
  -- Whose product this was at the moment of purchase. Recorded, not yet acted
  -- on: splitting an order across merchants is a later plan, and attribution
  -- cannot be reconstructed afterwards because a product's owner can change
  -- and a completed transaction's cannot.
  merchant_id   TEXT NOT NULL,
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
  -- Two finishes of one product are two lines. Keyed on (order_id, product_id)
  -- alone, ordering a black one and a silver one loses the second.
  PRIMARY KEY (order_id, product_id, variant)
);

-- The row count before the rebuild, which is the only thing that can tell the
-- guard below whether the join lost a line. Dropped once it has answered.
CREATE TABLE order_lines_backup AS SELECT * FROM order_lines;

-- A JOIN rather than a LEFT JOIN, deliberately: an unresolvable sku produces no
-- row at all, so the count changes and the guard catches it. A LEFT JOIN would
-- produce a row with a NULL product_id, which NOT NULL would also catch — but
-- only for the first such row, and it would say nothing about a sku that
-- matched two merchants' products and got copied twice.
INSERT INTO order_lines_new (order_id, product_id, merchant_id, sku, title, qty,
                             unit_price_cents, variant)
SELECT l.order_id, p.id, p.merchant_id, l.sku, l.title, l.qty, l.unit_price_cents, l.variant
  FROM order_lines l JOIN products p ON p.sku = l.sku;

DROP TABLE order_lines;

ALTER TABLE order_lines_new RENAME TO order_lines;

CREATE INDEX IF NOT EXISTS order_lines_merchant_idx ON order_lines(merchant_id);

-- Aborts the whole import if the join lost a row. Without it, an unresolvable
-- line disappears silently, which is the one outcome worse than failing.
--
-- Counts equal, the SELECT returns nothing and no row is inserted. Counts
-- differ, the row is inserted, qty -1 breaks CHECK (qty > 0) and the import
-- rolls back. Verified against SQLite 3.50.4 in both directions -- a guard that
-- never fires would be worse than no guard at all.
INSERT INTO order_lines (order_id, product_id, merchant_id, sku, title, qty,
                         unit_price_cents, variant)
SELECT 'ROLLBACK_GUARD', 'x', 'x', 'x', 'x', -1, 0, ''
 WHERE (SELECT COUNT(*) FROM order_lines) <> (SELECT COUNT(*) FROM order_lines_backup);

DROP TABLE order_lines_backup;
