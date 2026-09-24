-- The catalogue the storefront already renders does not fit the products table
-- as the tenancy core shipped it. Four fields are missing.
--
-- Columns for what gets filtered or sorted, JSON for what is a document. The
-- catalogue store filters on `badge` (its "deals only" toggle), so badge is a
-- column; specs_summary is three strings nobody queries by field.

ALTER TABLE products ADD COLUMN badge TEXT
  CHECK (badge IS NULL OR badge IN ('NEW_DROP','LIMITED_EDITION','DISCOUNT'));

-- Seed data today, an aggregate over a reviews table later. Never written by a
-- merchant: a seller who can set their own rating makes the platform not a
-- platform, which is why these two are absent from products.update's patch.
ALTER TABLE products ADD COLUMN rating REAL NOT NULL DEFAULT 0
  CHECK (rating >= 0 AND rating <= 5);

ALTER TABLE products ADD COLUMN review_count INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(review_count) = 'integer' AND review_count >= 0);

ALTER TABLE products ADD COLUMN specs_summary TEXT NOT NULL DEFAULT '[]';
