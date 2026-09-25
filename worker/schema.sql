-- Orders placed through the demo checkout.
--
-- Money is stored in integer cents, matching the cart store. A REAL column for
-- currency would reintroduce exactly the float drift the rest of the project
-- avoids: 899.95 * 3 is 2699.8500000000004.
CREATE TABLE IF NOT EXISTS orders (
  id            TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  email         TEXT NOT NULL,
  ship_name     TEXT NOT NULL,
  ship_phone    TEXT NOT NULL DEFAULT '',
  -- ISO 3166-1 alpha-2. Decides which subdivisions are legal, what a postcode
  -- looks like, and which tax was charged — so it is stored, not inferred.
  ship_country  TEXT NOT NULL DEFAULT 'US',
  ship_line1    TEXT NOT NULL,
  ship_line2    TEXT NOT NULL DEFAULT '',
  ship_city     TEXT NOT NULL,
  -- Empty for countries that have none, which is why there is no NOT NULL
  -- length check hiding in here.
  ship_state    TEXT NOT NULL,
  ship_postal   TEXT NOT NULL,
  method        TEXT NOT NULL CHECK (method IN ('standard','express','overnight')),
  currency      TEXT NOT NULL DEFAULT 'USD',
  subtotal_cents INTEGER NOT NULL,
  shipping_cents INTEGER NOT NULL,
  tax_cents      INTEGER NOT NULL,
  total_cents    INTEGER NOT NULL,
  -- The simulated gateway's outcome, kept so a declined attempt is auditable
  -- rather than silently absent.
  payment_status TEXT NOT NULL CHECK (payment_status IN ('succeeded','card_declined','insufficient_funds','expired_card')),
  -- Set from the session cookie at checkout, never from the payload. An order
  -- placed signed-out stays unlinked forever: matching on email later would
  -- hand anyone who registers an address a stranger's order history.
  user_id       TEXT
);

CREATE TABLE IF NOT EXISTS order_lines (
  order_id      TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  -- The catalogue id, globally unique. sku is kept because it is what a
  -- customer reads on a receipt, but it no longer identifies anything.
  product_id    TEXT NOT NULL,
  -- Whose product this was at the moment of purchase. Recorded, not yet acted
  -- on: splitting an order across merchants is a later plan, and attribution
  -- cannot be reconstructed afterwards because a product's owner can change
  -- and a completed transaction's cannot.
  merchant_id   TEXT NOT NULL,
  sku           TEXT NOT NULL,
  title         TEXT NOT NULL,
  qty           INTEGER NOT NULL CHECK (qty > 0),
  -- Frozen at the moment of purchase. Reading today's price back from the
  -- catalogue would rewrite history every time a price changes.
  unit_price_cents INTEGER NOT NULL,
  -- The finish chosen, validated against that product's colourways before it
  -- got here. Empty string rather than NULL because it is part of the key, and
  -- SQLite treats NULLs in a primary key as distinct from one another — which
  -- would let the same line be inserted twice.
  variant       TEXT NOT NULL DEFAULT '',
  -- Two finishes of one product are two lines. Keyed on (order_id, product_id)
  -- alone, ordering a black one and a silver one loses the second.
  PRIMARY KEY (order_id, product_id, variant)
);

-- Accounts. What one buys is narrow on purpose: the orders you placed while
-- signed in, on any device. The cart and the comparison stay on the device.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  -- Lower-cased by the application rather than by a collation, so one address
  -- cannot become two accounts.
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  -- PBKDF2-HMAC-SHA256, base64, per-user salt.
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  iterations    INTEGER NOT NULL,
  -- Chained passes of PBKDF2. The runtime caps one call at 100,000 iterations,
  -- so six passes is how 600,000 is reached. Stored per row, so it can be
  -- raised again and old rows re-hashed on next sign-in rather than locked out.
  kdf_rounds    INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  -- NULL means the address was typed but never proven.
  email_verified_at TEXT,
  -- A requested new address, waiting for its owner to prove they read it. The
  -- account keeps working on the old one until they do.
  pending_email TEXT,
  -- Per-account guessing backoff: what a per-IP limit cannot see.
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  -- A timestamp, not a boolean. A lock with no end is a way for a stranger to
  -- take an account away from its owner by guessing wrong five times.
  locked_until  TEXT,
  -- Base32, as the authenticator app expects it. NULL means no second factor.
  totp_secret   TEXT,
  -- Set only once a code has been checked: a secret that was generated and
  -- never confirmed must not lock anybody out.
  totp_confirmed_at TEXT
);

CREATE TABLE IF NOT EXISTS email_tokens (
  -- The SHA-256 of the token in the link, never the token itself.
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('verify','reset','email_change')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL,
  -- Single use, so a link forwarded, logged by a mail gateway or left in a
  -- browser history cannot be replayed.
  used_at     TEXT
);

-- The way back in when the phone is gone. Without these, turning on a second
-- factor is a way to lose an account.
CREATE TABLE IF NOT EXISTS recovery_codes (
  code_hash  TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  used_at    TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  -- The SHA-256 of the cookie, never the cookie. A dump of this table is a
  -- list of hashes rather than a set of working keys.
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS orders_email_idx ON orders(email);
CREATE INDEX IF NOT EXISTS orders_created_idx ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS orders_user_idx ON orders(user_id);
CREATE INDEX IF NOT EXISTS order_lines_merchant_idx ON order_lines(merchant_id);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS email_tokens_user_idx ON email_tokens(user_id);
CREATE INDEX IF NOT EXISTS recovery_codes_user_idx ON recovery_codes(user_id);
-- Read by the nightly sweep. Without them it is a full scan of every session
-- and link ever issued.
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS email_tokens_expiry_idx ON email_tokens(expires_at);

-- ------------------------------------------------------------------ tenancy

-- A merchant selling through NEXUS. `status` is not decoration: a suspended
-- merchant's products leave the storefront, and their orders stay, because
-- those are transactions that happened.
CREATE TABLE IF NOT EXISTS merchants (
  id                  TEXT PRIMARY KEY,
  slug                TEXT NOT NULL UNIQUE,
  name                TEXT NOT NULL,
  -- What they price in and are paid in. Denormalised onto each product at
  -- write time, so changing it never reinterprets an existing price.
  settlement_currency TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('pending','active','suspended')),
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

/*
 * Merchant and platform staff. Deliberately NOT the customer `users` table:
 * a `role` column there would make the boundary one `if` statement living
 * beside everything else that can have a bug.
 *
 * The encoding worth arguing about is `scope`. "merchant_id IS NULL means
 * platform" reads naturally and is the shape of a privilege-escalation bug —
 * anything that writes NULL into that column hands out a platform pass. The
 * paired CHECK below means the database refuses an incoherent row, so it is
 * not something to remember to check.
 */
CREATE TABLE IF NOT EXISTS staff (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  scope         TEXT NOT NULL CHECK (scope IN ('merchant','platform')),
  merchant_id   TEXT REFERENCES merchants(id),
  -- merchant: owner | member.  platform: admin.
  -- A column rather than a second table so a read-only 'support' role later
  -- is data instead of schema.
  role          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  iterations    INTEGER NOT NULL,
  kdf_rounds    INTEGER NOT NULL DEFAULT 1,
  totp_secret   TEXT,
  totp_confirmed_at TEXT,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((scope = 'merchant' AND merchant_id IS NOT NULL)
      OR (scope = 'platform' AND merchant_id IS NULL))
);

/*
 * Who did what to whose data.
 *
 * Recorded: every write by anyone, plus every PLATFORM read of merchant-scoped
 * data. Not merchant reads of their own data — that is noise and write volume.
 *
 * Merchants can read the entries about themselves. "NEXUS support viewed your
 * orders on 21 September" is what makes this a reason to join the platform
 * rather than only the platform's own defence.
 */
CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  at          TEXT NOT NULL DEFAULT (datetime('now')),
  actor_id    TEXT NOT NULL,
  actor_scope TEXT NOT NULL CHECK (actor_scope IN ('merchant','platform')),
  -- Whose data was touched. NULL only for actions that belong to no merchant.
  merchant_id TEXT REFERENCES merchants(id),
  action      TEXT NOT NULL,
  subject     TEXT,
  detail      TEXT
);

CREATE TABLE IF NOT EXISTS products (
  id           TEXT PRIMARY KEY,
  merchant_id  TEXT NOT NULL REFERENCES merchants(id),
  sku          TEXT NOT NULL,
  title        TEXT NOT NULL,
  brand        TEXT NOT NULL,
  category     TEXT NOT NULL,
  -- Minor units of `currency`, which is copied from the merchant at write
  -- time and frozen.
  price_minor  INTEGER NOT NULL CHECK (typeof(price_minor) = 'integer' AND price_minor >= 0),
  currency     TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('draft','published','archived')),
  stock_count  INTEGER NOT NULL DEFAULT 0 CHECK (typeof(stock_count) = 'integer' AND stock_count >= 0),
  -- Document-shaped and never queried by field, so JSON rather than columns.
  specs        TEXT NOT NULL DEFAULT '[]',
  colorways    TEXT NOT NULL DEFAULT '[]',
  media        TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  -- Per merchant, not global: two merchants may both sell IP18P-256.
  UNIQUE (merchant_id, sku)
);

CREATE INDEX IF NOT EXISTS products_merchant_idx ON products(merchant_id);
CREATE INDEX IF NOT EXISTS staff_merchant_idx ON staff(merchant_id);
CREATE INDEX IF NOT EXISTS audit_merchant_idx ON audit_log(merchant_id, at DESC);

-- Append-only, enforced. Verified against SQLite: both statements abort.
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT,'audit log is append-only'); END;

CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT,'audit log is append-only'); END;

-- ---------------------------------------------------------------- 0007
-- The 0006 block above must stay byte-identical to migrations/0006-tenancy.sql
-- (see the drift test), so these columns cannot be inlined into the products
-- CREATE TABLE above without breaking that test. Added the same way
-- production gets them: as the ALTER statements from 0007, verbatim.

ALTER TABLE products ADD COLUMN badge TEXT
  CHECK (badge IS NULL OR badge IN ('NEW_DROP','LIMITED_EDITION','DISCOUNT'));

ALTER TABLE products ADD COLUMN rating REAL NOT NULL DEFAULT 0
  CHECK (rating >= 0 AND rating <= 5);

ALTER TABLE products ADD COLUMN review_count INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(review_count) = 'integer' AND review_count >= 0);

ALTER TABLE products ADD COLUMN specs_summary TEXT NOT NULL DEFAULT '[]';

-- ---------------------------------------------------------------- 0010
-- Same reason as the 0007 block above: appended as the migration's own ALTER
-- rather than inlined into the CREATE TABLE, which would break the byte-for-byte
-- comparison against 0006-tenancy.sql.
--
-- Only the column is mirrored. 0010's 45 UPDATEs belong to the seeded rows,
-- not to the shape of the table.

ALTER TABLE products ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(display_order) = 'integer' AND display_order >= 0);

-- ---------------------------------------------------------------- 0011
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
  -- decides whether a session may act at all. No DEFAULT: an INSERT that
  -- forgets the column fails, rather than quietly issuing a session that can act.
  totp_pending INTEGER NOT NULL CHECK (totp_pending IN (0, 1))
);

CREATE INDEX IF NOT EXISTS staff_sessions_staff_idx ON staff_sessions(staff_id);
-- Read by the nightly sweep. Without it that is a full scan of every session
-- ever issued.
CREATE INDEX IF NOT EXISTS staff_sessions_expiry_idx ON staff_sessions(expires_at);

-- ---------------------------------------------------------------- 0012
-- The migration verbatim, below this line, which tenancy.spec.ts checks.
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

-- ---------------------------------------------------------------- 0013
-- The migration verbatim, below this line, which tenancy.spec.ts checks.
-- The order lifecycle: fulfilment per merchant, line-level refunds, the
-- platform's commission, and simulated payouts.
--
-- Additive only: one column on merchants, three new tables,
-- their indexes and triggers, and a backfill that inserts rows no existing
-- query reads. Production holds live orders, so nothing here rewrites one.
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
-- none, since nothing ships for them. OR IGNORE makes a second run harmless.
INSERT OR IGNORE INTO order_fulfilments (order_id, merchant_id)
SELECT DISTINCT l.order_id, l.merchant_id
  FROM order_lines l JOIN orders o ON o.id = l.order_id
 WHERE o.payment_status = 'succeeded';
