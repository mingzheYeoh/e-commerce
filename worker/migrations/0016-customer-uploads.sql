-- ---------------------------------------------------------------- 0016
-- Customer uploads: an avatar per account, product reviews with photos, and
-- return requests with photos. Additive only (one nullable column, four new
-- tables), so it is safe ahead of the workers that read it.
--
--   cd worker
--   npx wrangler d1 execute nexus-orders-staging --remote --file=migrations/0016-customer-uploads.sql
--
-- Semicolons, and the words that open and close a trigger body, are kept out of
-- these comments on purpose: test/d1-memory.ts splits on the one and balances the others.

-- The R2 key of the account's avatar in the public media bucket, minted by the
-- worker (avatars/<user>/<name>.webp). NULL means none.
ALTER TABLE users ADD COLUMN avatar_key TEXT;

-- One review per account and product, editable and deletable by its author.
-- merchant_id is copied from the product when the review is written, so a
-- merchant's read of its own reviews is a seek on its own id, like every
-- other tenant read. Products are never deleted, so the reference holds.
-- Closing an account deletes its reviews (and their photo rows) with it.
CREATE TABLE IF NOT EXISTS reviews (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id  TEXT NOT NULL REFERENCES products(id),
  merchant_id TEXT NOT NULL,
  rating      INTEGER NOT NULL CHECK (typeof(rating) = 'integer' AND rating BETWEEN 1 AND 5),
  body        TEXT NOT NULL DEFAULT '' CHECK (length(body) <= 1000),
  -- Set by a platform admin. A hidden review is out of the list and the average.
  hidden      INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, product_id)
);

-- The product page: visible reviews, newest first.
CREATE INDEX IF NOT EXISTS reviews_product_idx ON reviews(product_id, hidden, created_at DESC);
-- A merchant's reviews, newest first.
CREATE INDEX IF NOT EXISTS reviews_merchant_idx ON reviews(merchant_id, created_at DESC);

-- A review photo is two objects sharing a name, as a product photo is:
-- reviews/<review>/<name>-1600.webp and -400.webp. Order is insertion order.
CREATE TABLE IF NOT EXISTS review_photos (
  review_id  TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (review_id, name)
);

-- A shopper asking for money back on one merchant's delivered part of an
-- order. Who may ask is read off orders.user_id, not stored again here, so
-- the answer cannot drift from the order. No foreign key on order_id, the
-- same as order_lines.merchant_id, so a future rebuild of orders is not
-- blocked by it.
--
-- open -> approved (with the amount refunded) or open -> rejected (with a
-- note). The worker enforces the moves, and the CHECKs refuse the states no
-- move can produce.
CREATE TABLE IF NOT EXISTS return_requests (
  id            TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL,
  merchant_id   TEXT NOT NULL,
  reason        TEXT NOT NULL
                CHECK (reason IN ('damaged','wrong_item','not_as_described','changed_mind','other')),
  note          TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 1000),
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','approved','rejected')),
  -- Minor units of the part's currency, what the approval refunded.
  refund_minor  INTEGER CHECK (refund_minor IS NULL OR (typeof(refund_minor) = 'integer' AND refund_minor > 0)),
  decision_note TEXT CHECK (decision_note IS NULL OR length(decision_note) <= 1000),
  -- The staff id that decided, as the audit log records it.
  decided_by    TEXT,
  decided_at    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (status = 'open' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK (status <> 'approved' OR refund_minor IS NOT NULL),
  CHECK (status <> 'rejected' OR (decision_note IS NOT NULL AND length(decision_note) > 0))
);

-- One open request per part, whoever races to file a second.
CREATE UNIQUE INDEX IF NOT EXISTS return_requests_open_idx
  ON return_requests(order_id, merchant_id) WHERE status = 'open';
-- A merchant's queue.
CREATE INDEX IF NOT EXISTS return_requests_merchant_idx ON return_requests(merchant_id, status, created_at DESC);

-- Return photos live in the private bucket, returns/<request>/<name>.webp,
-- and are served only to the shopper, the part's merchant and the platform.
CREATE TABLE IF NOT EXISTS return_photos (
  return_id  TEXT NOT NULL REFERENCES return_requests(id),
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (return_id, name)
);
