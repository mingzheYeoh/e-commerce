-- ---------------------------------------------------------------- 0018
-- Product questions: a signed-in shopper asks, the product's merchant answers,
-- and only answered questions are public. Additive only (one new table), so
-- it is safe ahead of the workers that read it.
--
--   cd worker
--   npx wrangler d1 execute nexus-orders-staging --remote --file=migrations/0018-product-questions.sql
--
-- Semicolons, and the words that open and close a trigger body, are kept out of
-- these comments on purpose: test/d1-memory.ts splits on the one and balances the others.

-- merchant_id is copied from the product when the question is asked, so a
-- merchant's read of its own questions is a seek on its own id, like every
-- other tenant read. Closing an account deletes its questions with it.
-- A question with no answer is never public: that is the spam control.
-- answered_by is the staff id of whoever last wrote the answer, and
-- answered_at the first time it was answered, so editing an answer does not
-- move it up the product page.
CREATE TABLE IF NOT EXISTS product_questions (
  id          TEXT PRIMARY KEY,
  product_id  TEXT NOT NULL REFERENCES products(id),
  merchant_id TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body        TEXT NOT NULL CHECK (length(body) BETWEEN 10 AND 300),
  answer      TEXT CHECK (answer IS NULL OR length(answer) BETWEEN 1 AND 1000),
  answered_by TEXT,
  answered_at TEXT,
  -- Set by a platform admin. A hidden question is off the product page.
  hidden      INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((answer IS NULL) = (answered_at IS NULL))
);

-- The product page: answered, visible questions, newest answered first.
CREATE INDEX IF NOT EXISTS product_questions_public_idx
  ON product_questions(product_id, answered_at DESC) WHERE answer IS NOT NULL AND hidden = 0;
-- A shopper's own questions on a product: the pending list and the pending cap.
CREATE INDEX IF NOT EXISTS product_questions_user_idx ON product_questions(user_id, product_id);
-- A merchant's questions, newest first.
CREATE INDEX IF NOT EXISTS product_questions_merchant_idx ON product_questions(merchant_id, created_at DESC);
