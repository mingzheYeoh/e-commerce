-- Staff sessions, deliberately a separate table from `sessions`.
--
-- The same reasoning that kept staff out of the `users` table: one table with a
-- `kind` column makes the boundary an `if` in every query that touches it. Two
-- tables make a customer cookie and a staff cookie unable to be confused, because
-- they are looked up in different places.

CREATE TABLE IF NOT EXISTS staff_sessions (
  -- The SHA-256 of the cookie, never the cookie. A dump of this table is a list
  -- of hashes rather than a set of working keys.
  token_hash   TEXT PRIMARY KEY,
  staff_id     TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT NOT NULL,
  -- 1 while the holder has proved a password but not yet a second factor. Such
  -- a session may do exactly one thing: enrol TOTP. SQLite has no boolean, so
  -- the CHECK is what stops 'yes' and 2 from being storable in the column that
  -- decides whether a session may act at all.
  totp_pending INTEGER NOT NULL DEFAULT 0 CHECK (totp_pending IN (0, 1))
);

CREATE INDEX IF NOT EXISTS staff_sessions_staff_idx ON staff_sessions(staff_id);
-- Read by the nightly sweep. Without it that is a full scan of every session
-- ever issued.
CREATE INDEX IF NOT EXISTS staff_sessions_expiry_idx ON staff_sessions(expires_at);
