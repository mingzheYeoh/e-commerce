-- The platform back office reads across every merchant, so it cannot seek on a
-- merchant index the way the merchant pages do. EXPLAIN QUERY PLAN showed four
-- scans of tables that only grow, one per index below, and the test in
-- ../src/tenancy.spec.ts (the platform reads, planned) pins each as a SEARCH:
--
--   refunds, payouts    the payments ledger's date range, platform-wide
--   users               the customer list, newest sign-up first, and sign-ups
--                       by week (id rides along so a page of equal times needs
--                       no sort)
--   order_fulfilments   every pending part, platform-wide, for the overview
--
-- Indexes only, so safe in either order relative to the worker.

CREATE INDEX IF NOT EXISTS refunds_created_idx ON refunds(created_at);
CREATE INDEX IF NOT EXISTS payouts_created_idx ON payouts(created_at);
CREATE INDEX IF NOT EXISTS users_created_idx ON users(created_at, id);
CREATE INDEX IF NOT EXISTS order_fulfilments_status_idx ON order_fulfilments(status);
