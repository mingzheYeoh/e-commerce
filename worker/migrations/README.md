# Migrations

Applied by hand, in order, with:

```bash
npx wrangler d1 execute <db> --remote --file=migrations/000N-name.sql
```

`--file`, never `--command`. The import endpoint uploads the whole file and lets
D1 parse it, so the two triggers in `0006` survive; anything that splits on `;`
cuts `BEGIN SELECT RAISE(...)` from its `END`. The import is also all-or-nothing,
so a failure leaves the database exactly as it was.

## The rule

**Migrate before you deploy.** A worker deployed ahead of its tables starts
querying tables that do not exist. A migration ahead of its worker is harmless —
it only adds tables nobody reads yet.

**`0009` is the exception, and it is the first one.** The rule holds for
migrations that add tables or nullable columns. `0009` adds `product_id` and
`merchant_id` to `order_lines` as `NOT NULL`, and the worker's checkout still
inserts neither — so from the moment it lands, every checkout against that
database fails on `NOT NULL constraint failed: order_lines.product_id` and
`/api/checkout` returns 503. That is true on staging right now. The worker that
writes the two columns has to follow, and until it does this rule is inverted
for this one table.

## Where each one has been applied

Verified against `sqlite_master` on 2026-09-21; production caught up on 2026-09-24.

| | production `nexus-orders` | staging `nexus-orders-staging` |
|---|---|---|
| initial (`schema.sql`) | ✅ orders, order_lines | ✅ |
| `0001` order-line variant | ✅ | ✅ |
| `0002` addresses and accounts | ✅ 2026-09-24 | ✅ |
| `0003` auth hardening | ✅ 2026-09-24 | ✅ |
| `0004` recovery tokens | ✅ 2026-09-24 | ✅ |
| `0005` account settings | ✅ 2026-09-24 | ✅ |
| `0006` tenancy | ✅ | ✅ re-applied 2026-09-21 |
| `0007` catalogue columns | ✅ 2026-09-24 | ✅ |
| `0008` seed catalogue | ✅ 2026-09-24 | ✅ |
| `0009` order lines product id | ✅ 2026-09-24 | ✅ applied 2026-09-21 |
| `0010` display order | ✅ 2026-09-24 | ✅ applied 2026-09-21, rebuilt 2026-09-22 |
| `0011` staff sessions | ✅ 2026-09-24 | ✅ applied 2026-09-22 |
| `0012` audit merchant seq index | ✅ 2026-09-25 | ✅ 2026-09-25 |
| `0013` order lifecycle (+ `0013b` re-run) | ✅ 2026-09-26 | ✅ 2026-09-26 |
| `0014` platform back office indexes | ✅ 2026-09-26 | ✅ 2026-09-26 |
| `0015` payment method | ✅ 2026-09-26 | ✅ 2026-09-26 |
| `0016` customer uploads | pending | pending |

Until 2026-09-24 production held only `orders`, `order_lines` and the four
tables from `0006`; the accounts tables (`users`, `sessions`, `email_tokens`,
`recovery_codes`) arrived with `0002`–`0005` that day, along with the rest of
the catch-up listed under "Before production next deploys" below.

## Pending

**`0016` customer uploads, on neither database yet.** It adds
`users.avatar_key` (nullable) and four tables: `reviews` and `review_photos`
(one review per account and product; closing an account cascades to both),
`return_requests` (one open request per order part, enforced by the partial
unique index `return_requests_open_idx`) and `return_photos`. Additive only, so
it is safe ahead of the workers and must land before them: the phase 3
`nexus-api` reads `users.avatar_key` on every `/api/auth/me`, and both workers
read the new tables. Staging first, then production, each before its deploys:
`npx wrangler d1 execute <db> --remote --file=migrations/0016-customer-uploads.sql`

It runs **once** (its `ALTER TABLE` fails a second time). Check afterwards with
`SELECT name FROM sqlite_master WHERE name IN ('reviews','review_photos','return_requests','return_photos')`
— four rows.

The same deploy needs, before either worker goes out:

- **Two private R2 buckets**, bound as `PRIVATE` by both `wrangler.toml` and
  `wrangler.console.toml`: `npx wrangler r2 bucket create nexus-private` and
  `npx wrangler r2 bucket create nexus-private-staging`. Return photos go
  there. Never attach a public domain to either: they are served only through
  the authenticated `return-photos` routes.
- **`MEDIA_BASE` on nexus-api** (already in `wrangler.toml`, the same value
  the console has per environment), which avatar and review photo URLs are
  built from. Those objects go in the existing `nexus-media` /
  `nexus-media-staging` buckets under `avatars/` and `reviews/`.

### Applied: 0015

`0015` (payment method columns) ran on staging, then production, on
2026-09-26, each ahead of its nexus-api deploy; every stored order read back
as `card`.

### Before 0015

On 2026-09-26 both databases ran the runbook below in order: `0013`,
then nexus-api, nexus-console and the storefront, then `0013b` (production:
2 fulfilment parts for 2 expected, stock total unchanged at 1525), then
`0014`. The notes that follow are kept because they explain that order.

### Kept for the record


**`0013` order lifecycle, on neither database yet.** It adds
`merchants.commission_bps` (default 800) and `order_lines.commission_bps` (the
rate each line was sold at, default 800 for every line already stored), the
`order_fulfilments`, `refunds` and `payouts` tables with their indexes and
append-only triggers, and backfills one `pending` fulfilment row
(`stock_taken = 0`) per merchant of every paid order already stored. Additive
only, so it is safe ahead of the workers, and it has to be: the branch's
`nexus-api` inserts a fulfilment row, decrements `stock_count` and writes
`order_lines.commission_bps` in the order batch, and its `nexus-console` reads
all three tables, so a worker deployed ahead of `0013` fails every checkout
(503) and every order page.

`0013` runs **once**: its `ALTER TABLE`s fail a second time. Only its last
statement, the backfill, is safe to repeat, and it is also `0013b` on its own.

The runbook, staging first and then production, each in this order:

1. Apply `0013`:
   `npx wrangler d1 execute <db> --remote --file=migrations/0013-order-lifecycle.sql`
2. Deploy `nexus-api` (it must also get the new `ORDER_LIMITER` binding from
   `wrangler.toml`).
3. Deploy `nexus-console`.
4. Re-run the backfill, for the orders the old `nexus-api` took between steps
   1 and 2 — they have no fulfilment row, so no merchant could ship them:
   `npx wrangler d1 execute <db> --remote --file=migrations/0013b-backfill-fulfilments.sql`
5. Check that `SELECT COUNT(*) FROM order_fulfilments` equals
   `SELECT COUNT(*) FROM (SELECT DISTINCT l.order_id, l.merchant_id FROM order_lines l JOIN orders o ON o.id = l.order_id WHERE o.payment_status = 'succeeded')`.

Two hazards for any later migration that rebuilds a table the way `0009` did:

- **`order_lines`**: carry `commission_bps` across, or every past sale is
  re-priced at the default. Nothing in `0013` references `order_lines` from a
  trigger, on purpose (see the comment above the refunds triggers), so such a
  rebuild still works. Keep it that way.
- **`orders`**: `order_fulfilments.order_id` is `ON DELETE CASCADE`, and D1
  enforces foreign keys, so `DROP TABLE orders` inside a rebuild deletes every
  fulfilment row with it. Copy them aside first, or rebuild with foreign keys
  deferred.

**`0014` platform back office indexes, on neither database yet.** Four
indexes and nothing else — `refunds(created_at)`, `payouts(created_at)`,
`users(created_at, id)` and `order_fulfilments(status)` — for the platform's
payments ledger, customer list and overview cards, which read across every
merchant and so cannot seek on a merchant index. Index only, so it is safe in
either order relative to the workers, and `IF NOT EXISTS` makes a second run
harmless. It needs `0013` first, whose three tables (`refunds`, `payouts`,
`order_fulfilments`) three of its indexes are on, and `users` from `0002`,
which both databases have had since 2026-09-24. Run it
before (or right after) deploying the `nexus-console` that has the platform
pages; without it those pages work, but scan:
`npx wrangler d1 execute <db> --remote --file=migrations/0014-platform-back-office-indexes.sql`

`0012` (an index only) was applied to staging and then production on
2026-09-25, each ahead of the console worker that reads it.

## Before production next deploys

**Done 2026-09-24**, in this order: 0002–0005, 0007, 0008 (products = 45
confirmed), 0010, 0011, then 0009 immediately followed by the nexus-api
deploy. 0009 carried both existing order lines across (`NX-7H3QK` →
`iphone-18-pro`, `NX-EELGJ` → `xps-16`). R2 bucket `nexus-media` created.
The list below is kept because it explains why the order was what it was.

1. **Apply `0002` through `0005` first.** The moment a worker with
   `/api/auth/*` reaches production, every one of those routes queries a table
   that is not there. Today nothing does, because `sessionUser` returns null
   before touching the database when the request carries no session cookie, and
   in production nothing can issue one.

2. **Apply `0007` too.** It is on staging and not on production. It only adds
   columns, so it is safe ahead of the worker that reads them — the ordering
   rule above runs one way.

3. **`0009` needs `0008` in front of it, and a worker behind it.** Its backfill
   resolves `order_lines.sku` against `products`, and production has the
   `products` table from `0006` but none of the rows from `0008`. Run against
   production as it stands, every line would fail to resolve — the count guard
   then aborts the import rather than emptying the table, which is the outcome
   it exists for, but it means `0009` cannot land on production until `0008`
   has. Print `SELECT COUNT(*) FROM order_lines` first either way: `DROP TABLE`
   leaves no second chance to check what came across.

4. **`0010` needs `0008` in front of it too, and it is what `npm run build:catalog`
   reads.** Its ALTER is harmless anywhere, but its 45 UPDATEs address rows by
   id and match nothing on a database that has not been seeded — so on
   production as it stands every product would keep `display_order = 0`, and
   the generator would fall through to the `id` tiebreaker and write the
   storefront out alphabetically. That is why `build` still runs plain
   `vite build`: pointing it at production today would either fail on an empty
   table or reorder the shop page.

5. **`0008` has to land before this worker does, or production takes orders
   and throws them away.** `orders.ts`'s `resolve()` is now the only pricing
   path — the bundled copy of the frontend catalogue it replaced is gone — so
   `POST /api/orders` reads `products` for every line it is given. Production
   has that table from `0006` with zero rows, so every id fails to resolve and
   the route answers 400 `unknown product` for every order placed. Nothing
   surfaces it: `../../src/lib/api.ts`'s `saveOrder` collapses any non-2xx to
   `false`, and `checkout.ts` calls it with `void` on purpose, so the receipt
   is already written and the shopper sees a normal confirmation for an order
   the database never received. This is the failure the migrate-before-deploy
   rule exists to prevent and the one it does not cover, because no query
   errors — the table is there, it is just empty. Print
   `SELECT COUNT(*) FROM products` before deploying: 45 is right, 0 means stop.

6. **`0011` has to land before this branch's `nexus-api`, not only before the
   console.** The nightly sweep deletes expired `sessions`, `email_tokens` and
   `staff_sessions` in one batch, and a batch is one transaction: against a
   database without `staff_sessions` the whole sweep fails, customer tables
   included. Nothing surfaces it except `purge failed` in the worker's logs.

7. **Create the production photo bucket before deploying either worker.**
   `npx wrangler r2 bucket create nexus-media`. Both `wrangler.toml` and
   `wrangler.console.toml` bind it at the top level, and a deploy that binds a
   bucket which does not exist fails. Staging's is `nexus-media-staging`,
   created 2026-09-24; the two are separate on purpose, so a demo upload on
   staging can never appear behind a production URL.

## Known drift

**Staging's `staff_sessions.totp_pending` still has `DEFAULT 0`.** `0011`
dropped the default after staging had run it, so a production database that
runs `0011` fresh gets no default and an INSERT that forgets the column fails.
It changes no behaviour today: the only INSERT, in `staff-auth.ts`, names the
column and writes `1`. This is the same wrong-way-round drift as the two
rebuilds below. It is recorded here rather than rebuilt because nothing reaches it.

## Done, kept for the record

**Staging's `0006` was re-applied on 2026-09-21.** Staging had received the
tenancy tables while the tenancy plan's Task 1 was being verified, which was
before `price_minor` and `stock_count` gained their
`CHECK (typeof(...) = 'integer' AND ... >= 0)` clauses — so for a while the
test environment's constraints were *weaker* than production's, which is the
wrong way round and the hardest kind of drift to notice. The four empty tables
were dropped and `0006` re-run. Verified by probe: a negative price is refused
with `CHECK constraint failed: ... AND price_minor >= 0`, and the failed batch
rolled back so the probe merchant left nothing behind.

**Staging's `products` was rebuilt on 2026-09-22.** `0010` landed on staging
before its `display_order` gained
`CHECK (typeof(display_order) = 'integer' AND display_order >= 0)` — the same
drift as `0006` above, and the same wrong way round: the test environment's
constraints were weaker than what every database that runs `0010` from here on
will get. Amending the file cannot reach a database that has already run it,
and SQLite cannot add a CHECK to an existing column with `ALTER TABLE`, so
`products` was rebuilt the way `0009` rebuilds `order_lines` — new table, copy,
drop, rename, recreate `products_merchant_idx` — through one `--file` import,
with a guard comparing the copy to a backup of the original row for row rather
than only by count, because a 20-column copy loses data to two same-typed
columns swapping places, which a count cannot see. Production is unaffected: it
has never run `0010` and gets the CHECK from the file directly.

The recovery script was a one-off and is not in this directory. Reproducing it
means reading `0009` and the `products` block of `../schema.sql`, which is
where its shape came from.

Verified by probe: `display_order = 'abc'` and `display_order = -1` are both
refused with `CHECK constraint failed: typeof(display_order) = 'integer' AND
display_order >= 0`, and each failed batch rolled back — the probe merchant
inserted by the statement before left nothing behind. The 45 rows survived with
`display_order` 0–44, still distinct.

## Why the two files

`0006-tenancy.sql` and the tenancy block of `../schema.sql` are byte-identical,
and a test in `../src/tenancy.spec.ts` keeps them that way. `schema.sql` is what
the test harness loads into real SQLite; the migration is what a real database
actually runs. Before that test existed, every test proved the worker agreed
with the file production would never run.
