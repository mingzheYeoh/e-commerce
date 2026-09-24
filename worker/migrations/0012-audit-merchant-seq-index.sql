-- The audit log viewer, filtered to one merchant, newest first.
--
-- The viewer pages by rowid (insertion order) with a cursor, not by OFFSET.
-- Unfiltered, that is a seek on the table's own key and needs no index.
-- Filtered, audit_merchant_idx (merchant_id, at DESC) finds the merchant's
-- rows but not in rowid order, so SQLite sorted every one of them into a temp
-- B-tree for each page - and a merchant's rows only grow: the log is
-- append-only, and every platform list writes a row per merchant it read.
--
-- An index on merchant_id alone is enough, because SQLite ends every index
-- entry with the rowid: these entries run (merchant_id, rowid), which is the
-- order the page is read in. Checked with EXPLAIN QUERY PLAN, and pinned by a
-- test in ../src/tenancy.spec.ts.
--
-- Index only, so it is safe in either order relative to the worker.

CREATE INDEX IF NOT EXISTS audit_merchant_seq_idx ON audit_log(merchant_id);
