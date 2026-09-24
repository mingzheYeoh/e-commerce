# Catalogue migration — moving the products into D1

**Date:** 2026-09-21
**Status:** approved, ready for an implementation plan.
**Depends on:** `2026-09-21-merchant-admin-design.md` (the tenancy core, shipped
on `staging` as PR #14).

## Where this sits

The goal is the whole chain: merchants manage their own catalogue in a console.
That is three specs, and the seams are dependencies rather than a size budget.

```
① this one — the catalogue in D1 (read path)
     products → D1 · worker price table → D1 · the products.bin freshness story
        ↓ writes need something to write
② merchant identity and the write API
     staff login · HTTP routes over products.create / products.update
        ↓ a UI needs an API to call
③ the console SPA
```

The seam between ① and ② is not workload. `tenancy.ts` **scopes but does not
authorise** — `scopedTo(env, merchantId, staffId)` takes two bare strings and
trusts that the caller checked they belong together. The whole-branch review
recorded that as the largest residual risk, and today a doc comment is the only
defence. Exposing writes over HTTP before staff authentication exists would turn
that comment into a public endpoint.

---

## Section 1 — what moves where

```
D1 products ──┬─ build time   scripts/build-catalog.mjs
              │                 ├→ src/data/products.ts   (generated, committed)
              │                 ├→ public/media/search/products.json
              │                 └→ products.bin  (via the existing build-embeddings)
              │
              ├─ runtime       GET /api/products → catalog store overlay
              │
              └─ checkout      worker resolves price/title/finish by product id
```

The generated file keeps the path `src/data/products.ts` and keeps exporting
`products` and `featuredDrop`. **All 22 importers stay untouched**, and the
storefront's first paint is byte-identical to today's.

It is committed rather than gitignored. A fresh clone stays buildable without D1
credentials, and a catalogue change shows up as a reviewable diff.

## Section 2 — the two migrations

### `0007-catalogue-columns.sql`

The `products` table as shipped cannot hold the current catalogue. Four fields
are missing; `inStock` is derivable from `stock_count` and is not stored.

```sql
ALTER TABLE products ADD COLUMN badge TEXT
  CHECK (badge IS NULL OR badge IN ('NEW_DROP','LIMITED_EDITION','DISCOUNT'));
ALTER TABLE products ADD COLUMN rating REAL NOT NULL DEFAULT 0
  CHECK (rating >= 0 AND rating <= 5);
ALTER TABLE products ADD COLUMN review_count INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(review_count) = 'integer' AND review_count >= 0);
ALTER TABLE products ADD COLUMN specs_summary TEXT NOT NULL DEFAULT '[]';
```

Columns for what gets filtered or sorted, JSON for what is a document. The
catalogue store already filters on `badge` (`dealsOnly`), so it is a column.
`specs_summary` is three strings nobody queries by field.

**The plan must verify against real SQLite that `ADD COLUMN` accepts a CHECK.**
SQLite refuses UNIQUE and PRIMARY KEY in `ADD COLUMN`; CHECK is believed to be
permitted, and belief is not a migration.

**`rating` and `review_count` must not appear in `products.update`'s patch
type.** A merchant who can set their own rating makes the platform not a
platform. They are seed data now and become an aggregate over a reviews table
later.

### `0008-seed-catalogue.sql`

Generated once from the current `src/data/products.ts` by a script, committed,
and applied through the same `--file` path as every other migration. Forty-five
hand-written INSERTs is not a reviewable artifact.

The ordering matters and is easy to get backwards. `products.ts` is read by the
seed generator **while it is still the hand-written file**, and only afterwards
becomes the generated one. Once D1 holds the catalogue, the arrow reverses and
never points back:

```
step 1   hand-written products.ts  ──→  0008-seed-catalogue.sql  ──→  D1
step 2   D1  ──→  build-catalog.mjs  ──→  generated products.ts
```

### Price stops being a float

`Product.price` is the last surviving float in the money path, tolerated by a
comment that says it is "never used for arithmetic". D1 stores `price_minor`
as an integer. The frontend type becomes `priceMinor: number` and the division
happens only in the display formatter, which is the rule everywhere else.

## Section 3 — the merchant seed

One merchant per brand, `settlement_currency` `USD` for all of them,
`status = 'active'`. These are demo entities in a portfolio project, not a claim
of any real commercial relationship.

Multi-currency belongs to the money and FX plan. Seeding every merchant in one
currency now means the first FX bug is found by that plan's tests rather than
hidden in this one's fixtures.

## Section 4 — SKU stops being an identity

`products` is keyed `UNIQUE (merchant_id, sku)`, decided in the tenancy core
because two merchants may both sell `IP18P-256`. That decision was right and it
has a consequence nobody priced at the time: **SKU is no longer globally
unique, and the entire order pipeline is keyed on it.**

```
cart line      { sku }                    → { productId, sku }   sku kept for display
order payload  lines: { sku, qty, finish } → { productId, qty, finish }
order_lines    PK (order_id, sku, variant) → PK (order_id, product_id, variant)
               plus product_id, merchant_id
worker lookup  module-level PRICE_BY_SKU   → SELECT … WHERE id IN (…)
```

`PRICE_BY_SKU.get('IP18P-256')` would not fail on an ambiguous SKU. It would
return one merchant's price and charge it for another merchant's product, with
nothing logged. This is the one part of the plan that touches the live checkout
path, and it needs a regression test written before the fix: **two merchants,
same SKU, different prices, each resolving to its own.**

### The `order_lines` rebuild, and why its backfill window is closing

Changing a primary key is not an `ALTER TABLE` in SQLite. `order_lines` has to
be rebuilt: create the new shape, copy, drop, rename — inside one `--file`
import so the whole thing is all-or-nothing, the property that saved the
production database during the tenancy migration's failed first attempt.

Existing rows carry `sku` and no `product_id`, so the copy has to derive one.
**That derivation is only unambiguous while SKU is still globally unique**,
which is true today and stops being true the first time a second merchant lists
the same SKU. The backfill must therefore happen in the same migration that
seeds the catalogue, not in a later cleanup. A row whose product cannot be
resolved must abort the import rather than be copied with a guess — an order
line pointing at the wrong merchant's product is a falsified record of a
transaction that really happened.

The plan checks how many rows exist in each database before writing the
migration. The shape of the answer changes nothing about the migration and
everything about how carefully it is rehearsed.

`merchant_id` on `order_lines` is recorded, not acted on. Splitting an order
across merchants is a later plan; the attribution has to be written at the
moment the order is placed because it cannot be reconstructed afterwards —
a product's owner can change, a completed transaction's cannot.

Reading the price per checkout rather than once per isolate is not a regression.
The current map goes stale until the next deploy, and price is the last thing
that may be stale.

## Section 5 — the public catalogue read does not go through `tenancy.ts`

A new `worker/src/catalogue.ts` holds one function: `publishedProducts(env)`,
querying `WHERE status = 'published'` with no tenant predicate.

This looks like a tenancy bypass and is not, so the reason belongs in the code:

```
tenancy.ts protects merchant data.        Both doors are for staff.
A published product is public by definition.  A shopper is neither kind of staff.
```

Routing it through `platformWide` would write **an audit row per shopper**, and
a third door would destroy the "only two ways in" property that the tenancy core
exists to hold. Someone will eventually try to tidy this; the comment is what
stops them.

## Section 6 — freshness

```
keyword arm    runtime overlay, live from D1   a new product is findable at once
semantic arm   rebuilt at deploy               "meanings can be one deploy old"
```

No CI, no new secret. `npm run build` reads D1 through the wrangler session that
already exists on the machine that deploys.

The spec this one builds on assumed a nightly GitHub Action. There is no
`.github/workflows` directory in this repository at all, so that would have been
new infrastructure to build and then maintain. The runtime overlay already keeps
names, prices and stock live; only the vector for a brand-new product waits, and
nobody searches for a product by abstract description minutes after it is
listed. Parameterise the script's D1 access so a workflow can call it later
without a rewrite.

## Section 7 — testing

- `catalogue.spec.ts` — published products are visible across merchants; drafts
  and archived ones are not.
- `orders.spec.ts` — two merchants, one SKU, two prices, each line resolving to
  its own. Written first, and watched fail.
- the generator — run against a fixed D1 seed, output compared to a snapshot, so
  a change to the generated catalogue is something a human approves.

## Section 8 — not in this plan

The merchant write API, the console SPA, order splitting, a reviews table,
multi-currency, CI.

## What comes next

Plan ③ adds a second user-facing URL. The README then carries two:

```
storefront   nexus-tech-collective.…workers.dev   for shoppers
console      nexus-console.…workers.dev           for merchant staff
```

One URL for the console, not two: it is a single worker serving its own SPA and
its own API on one origin. That is the deliberate correction to the storefront's
historical two-worker split, which needs `ALLOWED_ORIGIN` and CORS. The console
is the highest-privilege surface in the system and is the last place that should
have cross-origin cookies; same-origin makes the browser's own policy part of
the isolation chain.
