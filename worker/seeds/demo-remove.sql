-- Removes the demo data scripts/seed-demo.ts adds: every row belonging to a
-- customer whose id starts usr_demo_, and the orders they placed. Nothing else
-- is touched. substr rather than LIKE, because _ is a LIKE wildcard.
--
--   cd worker
--   npx wrangler d1 execute nexus-orders-staging --remote --file=seeds/demo-remove.sql
--
-- refunds is append-only, so its delete guard is dropped for the one DELETE
-- and put back verbatim straight after. D1 runs the file as one unit: if any
-- statement fails, all of it rolls back, the guard included.
--
-- Before running on production: a payout recorded against balances that
-- include demo sales would leave that merchant's balance negative once the
-- sales are gone. The seed writes no payouts itself.

DELETE FROM product_questions WHERE substr(user_id, 1, 9) = 'usr_demo_';
DELETE FROM reviews WHERE substr(user_id, 1, 9) = 'usr_demo_';
DELETE FROM return_requests WHERE order_id IN (SELECT id FROM orders WHERE substr(user_id, 1, 9) = 'usr_demo_');

DROP TRIGGER refunds_no_delete;
DELETE FROM refunds WHERE order_id IN (SELECT id FROM orders WHERE substr(user_id, 1, 9) = 'usr_demo_');
CREATE TRIGGER IF NOT EXISTS refunds_no_delete BEFORE DELETE ON refunds
BEGIN SELECT RAISE(ABORT,'refunds are append-only'); END;

DELETE FROM order_fulfilments WHERE order_id IN (SELECT id FROM orders WHERE substr(user_id, 1, 9) = 'usr_demo_');
DELETE FROM order_lines WHERE order_id IN (SELECT id FROM orders WHERE substr(user_id, 1, 9) = 'usr_demo_');
DELETE FROM orders WHERE substr(user_id, 1, 9) = 'usr_demo_';
DELETE FROM users WHERE substr(id, 1, 9) = 'usr_demo_';
