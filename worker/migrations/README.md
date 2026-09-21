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
| `0006` tenancy | ✅ | ⚠️ see below |

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

2. **Re-apply `0006` to staging.** Staging received the tenancy tables while
   Task 1 was being verified, which was before `price_minor` and `stock_count`
   gained their `CHECK (typeof(...) = 'integer' AND ... >= 0)` clauses. Staging's
   copies therefore lack those constraints and no longer match this file. The
   tables are empty, so the fix is to drop the four and re-run `0006`.

## Why the two files

`0006-tenancy.sql` and the tenancy block of `../schema.sql` are byte-identical,
and a test in `../src/tenancy.spec.ts` keeps them that way. `schema.sql` is what
the test harness loads into real SQLite; the migration is what a real database
actually runs. Before that test existed, every test proved the worker agreed
with the file production would never run.
