-- 0013's backfill, on its own, to run again after the new workers are live.
--
-- Between applying 0013 and deploying the nexus-api that writes fulfilment
-- rows, the old worker keeps taking orders and opens no part for them. This
-- gives each of those its pending part (stock_taken 0: the old worker took no
-- stock). OR IGNORE leaves every part that already exists untouched, so it is
-- safe to run any number of times. tenancy.spec.ts checks it is the same
-- statement 0013 ends with.
--
--   cd worker
--   npx wrangler d1 execute nexus-orders-staging --remote --file=migrations/0013b-backfill-fulfilments.sql

INSERT OR IGNORE INTO order_fulfilments (order_id, merchant_id)
SELECT DISTINCT l.order_id, l.merchant_id
  FROM order_lines l JOIN orders o ON o.id = l.order_id
 WHERE o.payment_status = 'succeeded';
