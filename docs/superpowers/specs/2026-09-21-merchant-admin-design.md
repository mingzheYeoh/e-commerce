# Merchant admin — design

**Status:** in progress. Sections 1 and 2 are settled; section 3 onward is still
being worked through.

**Date:** 2026-09-21

NEXUS becomes a marketplace. Merchants sign in to a console to manage their own
products, stock and orders; NEXUS itself is the platform operator and sees
everything.

---

## What this is really about

`src/data/products.ts` is a 1,158-line TypeScript file, 45 products, compiled
into the frontend bundle. Twenty-four files import it, including four build
scripts that generate derived artifacts and the order endpoint that prices
orders from it.

`stockCount` is read in eight places and written in none — placing an order
does not decrement anything. "Check stock" today means reading a constant.

So the admin console is the small half. The large half is: **the catalogue
becomes data, and five derived things have to follow it.**

```
Vectorize index    remote, incremental upsert          tractable
Neo4j graph        remote, incremental write           tractable
products.bin       a static file shipped to browsers   the hard one
products.json      same                                the hard one
worker price table imported from the TS file           the hard one
```

That tension is unresolved at the time of writing and is addressed in the
foundation section.

---

## Scope

Four sub-projects. This spec covers the foundation only; the rest each get
their own spec → plan → implementation cycle.

| | |
|---|---|
| **0. Foundation** ← this spec | catalogue in the database, tenant model, isolation layer, audit log |
| 1. Inventory | decrement on order, concurrency |
| 2. Product management | the console UI, image upload |
| 3. Reports | order modelling, aggregation |

The foundation is first because the other three all stand on it, and getting it
wrong means rewriting every query written after it.

---

## Decisions taken

### Tenancy: multi-merchant, platform sees all

Merchants see only their own products and orders. NEXUS is the platform
operator and sees everything.

**Tenant isolation is the one invariant that cannot be got wrong.** One missing
`WHERE merchant_id = ?` and merchant A reads merchant B's orders.

### Identity: separate staff table, separate origin

Merchant and platform staff do **not** live in the customer `users` table.

The alternative — a `role` column on `users` — makes the isolation *one `if`
statement*, living in application code alongside everything else that can have
a bug. A separate table on a separate origin with its own cookie makes it the
browser's same-origin policy: the storefront being compromised does not reach
the console, not because the check is good but because the browser does not
allow it.

The auth module is reused; the table and the cookie name are not.

### Database: stay on Cloudflare D1

Not Supabase, not Neon — for now.

The argument for Postgres is row-level security: isolation enforced by the
database rather than by application code. That argument is weaker than it
looks. A Worker connects with a service key, which **bypasses RLS entirely**.
Getting real RLS means either adopting Supabase Auth — discarding the auth
system already built and tested here — or minting Postgres-readable JWTs,
which adds a link to the chain that fails in exactly the way RLS was meant to
prevent.

```
D1         a query layer you write and test        → data
Postgres   a JWT minter you write and test → RLS policies you write and test → data
```

Both are code you write. Postgres moves enforcement closer to the data, which
is genuinely better, but the chain is longer and the project already has a
working auth system on D1, a second cloud that has already caused trouble
(Neo4j: a leaked instance id, and idle-pausing), and 45 products.

**Revisit if:** reports need to run over millions of rows, realtime
subscriptions are wanted, or "Postgres RLS" is wanted on the CV — the last is a
legitimate portfolio reason and a product decision rather than a technical one.

Isolation is instead made **structural**: a query layer where an unscoped query
cannot be expressed.

```ts
const db = scopedTo(merchantId)   // the WHERE is added here, not by the caller
await db.products.list()
await db.orders.forRange(from, to)

const all = platformWide(staff)   // a separate, named entry point, not a boolean
```

With a test that enumerates every method on the query layer and asserts the
generated SQL carries a tenant predicate. A new method that forgets it turns
the suite red.

### Enterprise standard: the four things that are about correctness

A real enterprise marketplace also has read replicas, a warehouse, SSO/SCIM,
distributed tracing, Terraform and multi-region. At 45 products those are
ceremony — configuration that drifts and nobody reads.

These four are about correctness, not scale, and belong from day one because
retrofitting them means rewriting every query already written:

1. **Structural tenant isolation** — above.
2. **Audit log.** The platform can read every merchant's data, so *who read or
   changed whose* must leave a record. This is not a compliance checkbox; it is
   the precondition for a merchant trusting the platform at all.
3. **Reliable propagation.** A product changes and its index entry must follow.
   Cloudflare Queues, not fire-and-forget. (Queues is on the free plan.)
4. **Recoverable backups.** D1 Time Travel, and a restore that has been
   performed at least once — "we have backups" and "we have restored" are
   different claims.

### Cost

| | |
|---|---|
| Workers, D1, Queues, Durable Objects, Cron, Hyperdrive | free |
| **R2** — merchants uploading product images | **needs Workers Paid, $5/month** |
| Vectorize | Paid-plan product, already in use — confirm the account's plan |
| Domain | ~$10/year — the console's own origin, and sending email |

Object storage is the only new hard cost, and it is unavoidable: a merchant who
cannot upload an image is not using a merchant console.

---

## Section 1 — shape

### One repository, three deployment artifacts

```
domain/    money, regions, shipping, catalogue and order types and invariants
src/       storefront SPA      ┐  unchanged
worker/    storefront API      ┘  two workers, as today
admin/     console SPA + console API — one worker
```

No npm workspaces. `worker/` already imports `src/lib/*` by relative path and
it works; moving the genuinely shared files to `domain/` and importing from
there costs one move and no tooling.

**The console is a single worker serving both its own SPA and its own API.**
The storefront is split into two workers for historical reasons and the console
should not copy that. One worker means one origin, which means no CORS at all,
`SameSite=Strict` available, and one deployment that cannot version-skew its
own frontend against its own backend.

### How they connect

Not over HTTP. **The same database.**

```
admin worker ──┐
               ├──→ one D1
storefront API ┘

both import the same write invariants from domain/
a product changes → Cloudflare Queues → indexes rebuilt
```

The console does **not** call `nexus-api`. That would need service-to-service
auth, or cross-tenant read code inside the storefront API — and the point of
the separate origin is that the code which can read every merchant's data is
not in the storefront's bundle at all. Code that is not there cannot be
reached.

Three connections: **one database** (data), **one `domain/`** (rules), **one
queue** (propagation).

---

## Section 2 — money

### What is there now

`useCurrency.ts` holds a hardcoded rate table and a comment stating that "a
storefront this size does not need a live FX feed". That decision is reversed;
the comment has to go with it. A comment asserting a decision that no longer
holds is worse than no comment.

A live finding: **the order stores `currency` and the receipt never reads it.**
It renders in whatever currency the viewer has selected now. Under fixed rates
that is a cosmetic inconsistency. Under live rates it becomes *the same receipt
showing a different number every day*.

### "Live" does not mean tick-by-tick

A price that moves while somebody is looking at it is a broken storefront.
Commerce runs on **daily reference rates** — the ECB publishes once per working
day. Live here means *sourced, timestamped and updated*, not streamed.

### Display price is not the charged price

The moment a price appears next to a Pay button it is an offer. What happens to
the rate afterwards cannot change what was charged.

This is the same discipline as freezing `unitPriceCents` onto a cart line,
which this project already got right once.

The order freezes:

```sql
total_cents     INTEGER  -- platform currency (USD cents), the ledger
currency        TEXT     -- the currency transacted in
fx_rate         TEXT     -- frozen; TEXT not REAL, same reason money is integer cents
fx_rate_at      TEXT     -- when that rate was published
fx_source       TEXT     -- 'ECB' — provenance is what settles a dispute
total_charged   INTEGER  -- minor units of the transacted currency, frozen
```

Once `total_charged` is stored it is never recomputed. Reading an old order
shows what was actually taken, not today's rate applied to a dollar figure.

### Source and schedule

**Frankfurter** — ECB reference rates, free, no API key, once per working day.

```
existing cron (04:17) → fetch → D1 fx_rates (with as_of and source)
GET /api/fx           → current table + asOf, edge-cached for an hour
```

On a failed fetch: serve the last good rates and **show how old they are**.
Never fall back silently to a hardcoded table — that is the present state, and
its defect is that it cannot be noticed.

Rounding happens once, after conversion, and the displayed figure is the
charged figure. Showing RM 450.00 and taking RM 450.004 is an account that does
not reconcile.

### Merchants price in their own currency

Each merchant has a `settlement_currency`. They set prices in it; the platform
converts to the ledger currency at the day's rate.

The alternative — everyone prices in USD — is simpler and has one conversion
point instead of three (pricing, checkout, payout). It also asks a Malaysian
merchant to do arithmetic in their head before they can list a product, and
will be overturned by the first merchant who is not American.

This requires `fx_rates` to keep history, because a payout has to be computed
at the rate of a particular day and that day has to be recoverable.

---

## Open

- **Section 3 — tenant model and identity.** Table shapes; how the platform
  role is expressed; how the audit log records a platform user reading a
  merchant's data.
- **Section 4 — the catalogue in the database**, including how the static
  on-device embedding index stays honest once merchants can edit products.
- **Section 5 — testing**, in particular the test that proves isolation.
