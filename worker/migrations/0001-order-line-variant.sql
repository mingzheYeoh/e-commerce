-- Adds the chosen finish to an order line, and puts it in the key.
--
-- SQLite cannot alter a primary key, so the table is rebuilt. Existing rows
-- predate the field and take the empty string, which is what "no finish was
-- offered" stores as.
--
--   cd worker
--   npx wrangler d1 execute nexus-orders --remote --file=migrations/0001-order-line-variant.sql
--   npx wrangler d1 execute nexus-orders-staging --remote --file=migrations/0001-order-line-variant.sql

CREATE TABLE order_lines_new (
  order_id      TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sku           TEXT NOT NULL,
  title         TEXT NOT NULL,
  qty           INTEGER NOT NULL CHECK (qty > 0),
  unit_price_cents INTEGER NOT NULL,
  variant       TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (order_id, sku, variant)
);

INSERT INTO order_lines_new (order_id, sku, title, qty, unit_price_cents, variant)
  SELECT order_id, sku, title, qty, unit_price_cents, '' FROM order_lines;

DROP TABLE order_lines;
ALTER TABLE order_lines_new RENAME TO order_lines;
