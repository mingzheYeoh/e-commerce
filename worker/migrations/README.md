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

Production currently holds six tables: `orders`, `order_lines`, and the four
from `0006`. It has never had `users`, `sessions`, `email_tokens` or
`recovery_codes`.

That is not a fault. The worker deployed to production predates the accounts
work — `/api/auth/me` returns 404 there and `/api/health` carries no `auth`
key — so the code and the schema agree with each other. Production is behind
staging by the whole accounts phase, not broken by it.

## Pending

Nothing. `0012` (an index only) was applied to staging and then production on
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
