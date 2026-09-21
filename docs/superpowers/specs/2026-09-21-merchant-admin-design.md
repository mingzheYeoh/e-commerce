# Merchant admin — design

**Status:** design complete and approved section by section. Ready for an
implementation plan.

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

That tension is resolved in section 4.

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

**A marketplace order touches three currencies, not two.** This was missed on
the first pass of this section and caught in review: merchants pricing in their
own currency (below) adds a third leg, and a payout that does not reconcile
with a charge is the worst kind of bug to find late.

```
merchant settlement   MYR   what the merchant priced in and is owed
platform ledger       USD   the books
shopper charged       EUR   what the card was actually debited
```

Every amount a human is ever shown or paid is stored, along with the rate that
produced it. Nothing is recomputed:

```sql
-- on each merchant order
settlement_minor     INTEGER  -- what this merchant is owed
settlement_currency  TEXT
ledger_cents         INTEGER  -- USD cents, the books
charged_minor        INTEGER  -- what the shopper was actually debited
charged_currency     TEXT
fx_settlement_rate   TEXT     -- settlement → ledger; TEXT not REAL, same reason money is integer cents
fx_charged_rate      TEXT     -- ledger → charged
fx_rate_at           TEXT     -- when those rates were published
fx_source            TEXT     -- 'ECB' — provenance is what settles a dispute
```

Once stored, none of it is recomputed. Reading an old order shows what was
actually taken and what is actually owed, not today's rate applied to a dollar
figure. Two derived amounts and two rates look like more than is needed until
the first month-end where a payout and a charge disagree by four cents and
nobody can say which number was wrong.

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


---

## Section 3 — tenancy and identity

### `merchants`

```sql
CREATE TABLE merchants (
  id                  TEXT PRIMARY KEY,
  slug                TEXT NOT NULL UNIQUE,
  name                TEXT NOT NULL,
  settlement_currency TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('pending','active','suspended')),
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
```

`status` is not decoration. A suspended merchant's products leave the
storefront; their orders stay, because those are transactions that happened.

### `staff` — the dangerous state is unrepresentable

Merchant and platform staff share one table, one auth path and one login form.
They do **not** share the customer `users` table.

```sql
CREATE TABLE staff (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE,
  scope        TEXT NOT NULL CHECK (scope IN ('merchant','platform')),
  merchant_id  TEXT REFERENCES merchants(id),
  role         TEXT NOT NULL,   -- merchant: owner|member    platform: admin
  -- auth columns reuse the existing module: password_hash, kdf_rounds, totp_secret, …
  CHECK ((scope = 'merchant' AND merchant_id IS NOT NULL)
      OR (scope = 'platform' AND merchant_id IS NULL))
);
```

The obvious encoding is "`merchant_id IS NULL` means platform". That is the
shape of a privilege-escalation bug: anything that writes NULL into that column
hands out a platform pass. An explicit `scope` plus the paired CHECK means the
database refuses an incoherent row — verified against SQLite:

```
merchant staff with merchant_id = NULL  → CHECK constraint failed
platform staff with a merchant_id       → CHECK constraint failed
```

This is not validation. Validation is something you remember to do; a
constraint is something you cannot avoid.

Platform staff all carry `role = 'admin'` for now. The column exists so that
adding a read-only `support` role later is data rather than schema.

### Scope, and the asymmetry

```ts
type Scope =
  | { kind: 'merchant'; merchantId: string; staffId: string }
  | { kind: 'platform'; staffId: string }
```

The query layer accepts only a `Scope`. Merchant scope adds the predicate;
platform scope does not — **but every platform read of merchant data is
audited.**

The asymmetry is deliberate. A merchant reading their own data is not an event.
The platform reading it is.

### `audit_log` — genuinely append-only

```sql
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT,'audit log is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT,'audit log is append-only'); END;
```

Verified: both an UPDATE and a DELETE are refused. A log whose history can be
rewritten is not a log.

Recorded: every write by anyone, plus every **platform** read of merchant-scoped
data. Not merchant reads of their own data — that is noise and write volume.

**Merchants can read the entries about themselves.** "NEXUS support viewed your
orders on 21 September" is the part that makes the log a reason to join the
platform rather than only the platform's own defence.

### Orders split at checkout

A cart can hold products from several merchants. One customer `order_group`
becomes N merchant orders, which is what real marketplaces do.

The alternative — one order whose lines carry a `merchant_id` — makes every
merchant-facing query a join plus a caveat that the total on screen is not the
order's total. **Refunds break it first:** refunding an order spanning two
merchants has no obvious answer to whose money goes back.

This restructures the existing `orders` table, which is live. The migration is
part of the foundation work rather than an afterthought.

### Consequences for existing code

- **SKUs stop being globally unique.** Two merchants may both sell
  `IP18P-256`. `PRICE_BY_SKU`, a global map in `worker/src/orders.ts`, cannot
  survive this; order lines reference a stable `product_id` and carry a frozen
  copy of sku, title and price.
- `UNIQUE (merchant_id, sku)` replaces any global uniqueness assumption.


---

## Section 4 — the catalogue in the database

### `products`

```sql
CREATE TABLE products (
  id           TEXT PRIMARY KEY,            -- the slug already used in URLs
  merchant_id  TEXT NOT NULL REFERENCES merchants(id),
  sku          TEXT NOT NULL,
  title        TEXT NOT NULL,
  brand        TEXT NOT NULL,
  category     TEXT NOT NULL,
  price_minor  INTEGER NOT NULL,            -- minor units of the merchant's currency
  currency     TEXT NOT NULL,               -- denormalised from the merchant, frozen on write
  status       TEXT NOT NULL CHECK (status IN ('draft','published','archived')),
  stock_count  INTEGER NOT NULL DEFAULT 0,
  specs        TEXT NOT NULL DEFAULT '[]',  -- JSON
  colorways    TEXT NOT NULL DEFAULT '[]',  -- JSON
  media        TEXT NOT NULL DEFAULT '{}',  -- JSON
  UNIQUE (merchant_id, sku)
);
```

Currency is denormalised onto the row and frozen. A merchant changing their
settlement currency must not silently reinterpret the price of everything they
have already listed.

Queryable things get real columns; document-shaped things get JSON. `specs` is
`{label, value}[]` of free text that is never queried by field — it is a
document, not a relation.

### What happens to each derived artifact

```
worker price table   read from D1 instead of importing the TS file   solved
Vectorize index      queue consumer, incremental upsert              solved
Neo4j graph          same                                            solved
products.json        small; generated live by the worker             solved
products.bin         ← the real problem
```

### The real problem, stated precisely

```
on-device query embedding   Xenova/all-MiniLM-L6-v2      runs in the browser
hosted index                @cf/baai/bge-small-en-v1.5   runs in a Worker
```

Two models are two incompatible vector spaces. Keyless, offline, instant search
requires the *query* to be embedded in the browser, which means MiniLM; MiniLM
cannot run in a Worker — its 26.8MB of wasm is exactly what had to be dropped
to get under the 25MiB deploy limit.

So `products.bin` can only be rebuilt where Node runs: CI. A merchant editing a
product cannot update it in place.

### The resolution falls out of what is already there

Search is already two arms fused by reciprocal rank fusion
(`src/lib/retrieval.ts`).

```
keyword arm    reads product text    → live from D1      a new product is findable at once
semantic arm   reads products.bin    → rebuilt nightly   up to a day behind
               fused by RRF
```

**Names are fresh; meanings can be a day old.**

Someone searching "iPhone 18" finds a just-listed iPhone immediately, through
the keyword arm. Someone searching "something for taking calls in an open-plan
office" gets last night's semantic index. The degradation is honest and close
to invisible, because nobody looks for a product by abstract description two
minutes after it is listed.

`products.bin` is rebuilt by a scheduled GitHub Action — nightly, plus a
debounced trigger on catalogue change. That action is the only new piece of CI
infrastructure this project takes on.

### One pattern, three times

```
catalogue        build-time snapshot + revalidate on load
FX rates         last good + daily refresh
semantic index   nightly rebuild + live keyword arm
```

All three are *use what is in hand, then correct it*. The storefront is
currently a static site that renders without the API, and that property is
worth keeping — so the catalogue is not "fetched from an API", it is **baked in
at build time and revalidated after load**. First paint stays as fast as it is
today and becomes current within a second.

---

## Section 5 — proving the isolation

Tenant isolation is the one invariant that cannot be got wrong, so it gets
tests that are about *proof* rather than coverage.

The weak version is a test per endpoint asserting merchant A cannot read
merchant B. It only covers the endpoints somebody remembered, and the failure
mode being defended against is **a query added later without the predicate**.

### Three tests that hold each other up

**1. A poisoned second tenant.** The fixture seeds merchant B with values
marked so they are trivially detectable — ids prefixed `LEAK_`. Every method on
the scoped repository is called with merchant A's scope, and the serialised
result is asserted never to contain that marker. No knowledge of each
response's shape is needed; only that B's data never appears in A's answer.

**2. Audit completeness.** Every method called with a *platform* scope must
leave a row in `audit_log`. The asymmetry from section 3, enforced rather than
remembered.

**3. The completeness test that makes the first two structural.**

```ts
it('every method on the scoped repository has an isolation case', () => {
  expect(allMethodsOf(scopedTo('mch_a')).sort()).toEqual(Object.keys(CASES).sort())
})
```

Adding `db.payouts.list()` without adding a case turns the suite red. Without
this third test the first two are only as good as somebody's memory, which is
the thing being designed out.

### Why behaviour and not SQL text

Asserting the generated SQL contains `merchant_id = ?` is tempting and weak:
`WHERE something OR merchant_id = ?` passes it, and it tests a string rather
than an outcome. Seeding two tenants and looking at what comes back tests the
thing that actually matters.

### Schema drift is already covered

The test harness loads the project's own `schema.sql` into real SQLite, so a
statement naming a column that does not exist fails in the suite. That is what
surfaced `schema.sql` having drifted three migrations behind, and it keeps
working as a guard without a further test.

Going forward, a `migrations/0000-initial.sql` should exist so that "fresh
database from schema.sql" and "existing database through every migration" are
two paths that can be compared rather than assumed to agree.

