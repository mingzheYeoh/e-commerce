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

Verified against `sqlite_master` on 2026-09-21.

| | production `nexus-orders` | staging `nexus-orders-staging` |
|---|---|---|
| initial (`schema.sql`) | ✅ orders, order_lines | ✅ |
| `0001` order-line variant | ✅ | ✅ |
| `0002` addresses and accounts | ❌ | ✅ |
| `0003` auth hardening | ❌ | ✅ |
| `0004` recovery tokens | ❌ | ✅ |
| `0005` account settings | ❌ | ✅ |
| `0006` tenancy | ✅ | ✅ re-applied 2026-09-21 |
| `0007` catalogue columns | ❌ | ✅ |
| `0008` seed catalogue | ❌ | ✅ |
| `0009` order lines product id | ❌ | ✅ applied 2026-09-21 |

Production currently holds six tables: `orders`, `order_lines`, and the four
from `0006`. It has never had `users`, `sessions`, `email_tokens` or
`recovery_codes`.

That is not a fault. The worker deployed to production predates the accounts
work — `/api/auth/me` returns 404 there and `/api/health` carries no `auth`
key — so the code and the schema agree with each other. Production is behind
staging by the whole accounts phase, not broken by it.

## Two things to do before production next deploys

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

## Why the two files

`0006-tenancy.sql` and the tenancy block of `../schema.sql` are byte-identical,
and a test in `../src/tenancy.spec.ts` keeps them that way. `schema.sql` is what
the test harness loads into real SQLite; the migration is what a real database
actually runs. Before that test existed, every test proved the worker agreed
with the file production would never run.
