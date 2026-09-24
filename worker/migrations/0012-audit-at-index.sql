-- The audit log viewer, newest first across every merchant.
--
-- audit_merchant_idx (merchant_id, at DESC) serves the filtered view, but the
-- unfiltered one - `ORDER BY at DESC LIMIT 51` - has no merchant to lead with,
-- so without this every page view scans and sorts the whole log. That table
-- only grows: it is append-only by trigger, and a platform list writes one row
-- per merchant it touched.
--
-- No other dashboard query needed one. Merchant sales lead with
-- order_lines_merchant_idx, platform sales with orders_created_idx, and
-- products with products_merchant_idx.
--
-- Index only, so it is safe in either order relative to the worker.

CREATE INDEX IF NOT EXISTS audit_at_idx ON audit_log(at DESC);
