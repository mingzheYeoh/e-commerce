-- The order lifecycle: fulfilment per merchant, line-level refunds, the
-- platform's commission, and simulated payouts.
--
-- Additive only: a column on merchants and one on order_lines, three new
-- tables, their indexes and triggers, and a backfill that inserts rows no
-- existing query reads. Production holds live orders, so nothing here rewrites
-- one. The ALTERs make this file run once only. The backfill statement at the
-- foot is the one part that can run again, and is also 0013b, which the
-- runbook in README.md re-runs after the workers are deployed.
--
-- Safe ahead of the worker that reads it (the ordering rule in README.md): the
-- old nexus-api never touches these tables, and an order it places after this
-- lands simply has no fulfilment row until the new worker is deployed.
--
--   cd worker
--   npx wrangler d1 execute nexus-orders-staging --remote --file=migrations/0013-order-lifecycle.sql
--
-- Semicolons, and the words that open and close a trigger body, are kept out of
-- these comments on purpose: test/d1-memory.ts splits on the one and balances the others.

-- What the platform keeps of each merchant's net sales, in basis points: 800 is
-- 8%. An integer, so commission is integer arithmetic and never a float.
ALTER TABLE merchants ADD COLUMN commission_bps INTEGER NOT NULL DEFAULT 800
  CHECK (typeof(commission_bps) = 'integer' AND commission_bps >= 0 AND commission_bps <= 10000);

-- The rate each line was sold at, copied from the merchant at checkout, so a
-- later change to the merchant's rate never re-prices a past sale. Every line
-- already stored was sold while every merchant was implicitly at 8%, which is
-- exactly the default, so no backfill UPDATE is needed. Any future rebuild of
-- order_lines (as 0009 did) must carry this column across.
ALTER TABLE order_lines ADD COLUMN commission_bps INTEGER NOT NULL DEFAULT 800
  CHECK (typeof(commission_bps) = 'integer' AND commission_bps >= 0 AND commission_bps <= 10000);

-- Each merchant ships its own part of an order, so status is per (order,
-- merchant), not per order: one seller can have shipped while another has not.
--
-- pending -> shipped -> delivered, or pending -> cancelled. The transitions
-- are enforced by the worker (tenancy.ts), and the CHECKs below refuse the states
-- no transition can produce, whoever writes the row.
CREATE TABLE IF NOT EXISTS order_fulfilments (
  order_id     TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  -- No foreign key, the same as order_lines.merchant_id it is copied from.
  merchant_id  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','shipped','delivered','cancelled')),
  carrier      TEXT,
  tracking     TEXT,
  shipped_at   TEXT,
  delivered_at TEXT,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  -- 1 when checkout took this part's units out of stock, which is what a
  -- cancel may put back. A part backfilled from before 0013 never took any
  -- (stock was not decremented then), so it stays 0 and its cancel restocks
  -- nothing, or it would conjure units.
  stock_taken  INTEGER NOT NULL DEFAULT 0 CHECK (stock_taken IN (0, 1)),
  PRIMARY KEY (order_id, merchant_id),
  -- A shipped or delivered part always says how and when it left.
  CHECK (status NOT IN ('shipped','delivered')
         OR (carrier IS NOT NULL AND tracking IS NOT NULL AND shipped_at IS NOT NULL)),
  CHECK (status <> 'delivered' OR delivered_at IS NOT NULL)
);

-- A merchant's queue: what is still to ship.
CREATE INDEX IF NOT EXISTS order_fulfilments_merchant_idx ON order_fulfilments(merchant_id, status);

-- Money back, per order line. Amounts are minor units of the line's own
-- currency (the product's), like everything else here.
--
-- qty is how many units the refund is for, and 0 is a goodwill refund of money
-- only. The cap is on both: never more units than were bought, never more
-- money than was paid for the line, counting every earlier refund.
CREATE TABLE IF NOT EXISTS refunds (
  id           TEXT PRIMARY KEY,
  order_id     TEXT NOT NULL,
  merchant_id  TEXT NOT NULL,
  product_id   TEXT NOT NULL,
  -- Part of the line key: two finishes of one product are two lines.
  variant      TEXT NOT NULL DEFAULT '',
  qty          INTEGER NOT NULL CHECK (typeof(qty) = 'integer' AND qty >= 0),
  amount_minor INTEGER NOT NULL CHECK (typeof(amount_minor) = 'integer' AND amount_minor > 0),
  reason       TEXT NOT NULL,
  -- Who, as the audit log records it: a staff id and the scope it acted in.
  actor_id     TEXT NOT NULL,
  actor_scope  TEXT NOT NULL CHECK (actor_scope IN ('merchant','platform')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS refunds_line_idx ON refunds(order_id, product_id, variant);
CREATE INDEX IF NOT EXISTS refunds_merchant_idx ON refunds(merchant_id);

-- The cap is enforced in the write, by the worker, not by a trigger here. Every
-- batch that inserts a refund ends with a guard statement (0009's trick) that
-- inserts a row with qty -1 if any line of the order is now over its cap, so
-- the CHECK above fails and the whole batch rolls back: the refund, its audit
-- row and any status change beside it. A BEFORE INSERT trigger reading
-- order_lines was tried and dropped: SQLite then refuses to rebuild order_lines
-- (rename a new table into its place, as 0009 did) while the trigger exists.

-- A ledger is append-only, like the audit log: a correction is a new row.
CREATE TRIGGER IF NOT EXISTS refunds_no_update BEFORE UPDATE ON refunds
BEGIN SELECT RAISE(ABORT,'refunds are append-only'); END;

CREATE TRIGGER IF NOT EXISTS refunds_no_delete BEFORE DELETE ON refunds
BEGIN SELECT RAISE(ABORT,'refunds are append-only'); END;

-- Simulated settlement: the platform records that it paid a merchant. Nothing
-- moves money. The worker refuses an amount over the merchant's available
-- balance in that currency, in the same statement that inserts it.
CREATE TABLE IF NOT EXISTS payouts (
  id           TEXT PRIMARY KEY,
  merchant_id  TEXT NOT NULL REFERENCES merchants(id),
  currency     TEXT NOT NULL CHECK (length(currency) = 3),
  amount_minor INTEGER NOT NULL CHECK (typeof(amount_minor) = 'integer' AND amount_minor > 0),
  -- The period or bank reference the payout covers, as the platform typed it.
  reference    TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS payouts_merchant_idx ON payouts(merchant_id, currency);

CREATE TRIGGER IF NOT EXISTS payouts_no_update BEFORE UPDATE ON payouts
BEGIN SELECT RAISE(ABORT,'payouts are append-only'); END;

CREATE TRIGGER IF NOT EXISTS payouts_no_delete BEFORE DELETE ON payouts
BEGIN SELECT RAISE(ABORT,'payouts are append-only'); END;

-- Every paid order already stored gets its parts, all pending: none was ever
-- marked shipped, because until now there was no way to. Declined attempts get
-- none, since nothing ships for them. stock_taken stays 0. OR IGNORE makes a
-- second run of this statement (0013b) harmless, and it must be re-run once
-- the new nexus-api is live, for orders the old one placed in between.
INSERT OR IGNORE INTO order_fulfilments (order_id, merchant_id)
SELECT DISTINCT l.order_id, l.merchant_id
  FROM order_lines l JOIN orders o ON o.id = l.order_id
 WHERE o.payment_status = 'succeeded';
