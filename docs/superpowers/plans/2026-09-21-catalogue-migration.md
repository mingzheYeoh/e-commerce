# Catalogue Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the 45-product catalogue out of a TypeScript source file and into D1, so that the worker prices a checkout from the database rather than from bundled frontend data.

**Architecture:** D1 is the source of truth. A build-time generator writes `src/data/products.ts` from D1, so all 22 existing importers stay untouched and first paint is unchanged; a runtime overlay refreshes the catalogue store after load. The worker resolves prices by product id, because `UNIQUE (merchant_id, sku)` means SKU is no longer a global identity.

**Tech Stack:** Cloudflare D1 (SQLite), Workers, Vue 3 + Pinia, Vitest, `node:sqlite` as the test double.

## Global Constraints

- Money is integer minor units everywhere. The only division is in the display formatter.
- Migrations are applied with `--file`, never `--command`. The import endpoint is all-or-nothing and parses the whole file, so trigger bodies survive.
- `worker/schema.sql` and the migration files must stay byte-identical where they overlap. A test in `worker/src/tenancy.spec.ts` enforces this for the tenancy block; extend it, do not bypass it.
- `rating` and `review_count` are never merchant-writable. They must not appear in `products.update`'s patch type.
- No migration is applied to production `nexus-orders` without the user's explicit go-ahead. Staging is `nexus-orders-staging`.
- `npm run typecheck` covers `worker/` and must exit 0. Never satisfy it with `as unknown as`.
- Do not merge to `main`. PRs target `staging`.

## File Structure

| File | Responsibility |
|---|---|
| `worker/migrations/0007-catalogue-columns.sql` | The four columns the catalogue needs |
| `worker/migrations/0008-seed-catalogue.sql` | Generated: merchants + 45 products |
| `worker/migrations/0009-order-lines-product-id.sql` | Rebuild `order_lines` around product id |
| `worker/schema.sql` | Fresh-database shape; mirrors all of the above |
| `scripts/seed-catalogue.mjs` | One-time: hand-written catalogue → `0008` |
| `scripts/build-catalog.mjs` | Ongoing: D1 → `src/data/products.ts` + `products.json` |
| `worker/src/catalogue.ts` | `publishedProducts(env)` — the public read, deliberately outside `tenancy.ts` |
| `worker/src/orders.ts` | Price/title/finish resolution by product id |
| `src/types/index.ts` | `price: number` → `priceMinor: number` |
| `src/stores/cart.ts`, `checkout.ts`, `catalog.ts` | Carry product id; overlay live catalogue |

---

### Task 1: The four columns the catalogue needs

**Files:**
- Create: `worker/migrations/0007-catalogue-columns.sql`
- Modify: `worker/schema.sql` (the `products` table)
- Test: `worker/src/tenancy.spec.ts` (append to the schema-constraints describe block)

**Interfaces:**
- Produces: `products.badge`, `products.rating`, `products.review_count`, `products.specs_summary`. Task 3 writes them, Task 5 reads them.

Verified against real SQLite before this plan was written: `ALTER TABLE ... ADD COLUMN` accepts a CHECK, the CHECK bites on insert, and existing rows take the default. UNIQUE and PRIMARY KEY are the constraints `ADD COLUMN` refuses; these are neither.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe('the schema refuses states that must not exist', ...)` in `worker/src/tenancy.spec.ts`:

```ts
  const seedMerchant = (raw: import('node:sqlite').DatabaseSync) =>
    raw.prepare(`INSERT INTO merchants (id, slug, name, settlement_currency, status)
                 VALUES ('mch_a','a','A','USD','active')`).run()

  const insertProduct = (raw: import('node:sqlite').DatabaseSync, cols: string, vals: string) =>
    raw.prepare(`INSERT INTO products (id, merchant_id, sku, title, brand, category,
                                       price_minor, currency, status${cols})
                 VALUES ('p1','mch_a','SKU','T','B','C',119900,'USD','draft'${vals})`).run()

  it('will not store a badge outside the three it knows', () => {
    const { raw } = memoryD1()
    seedMerchant(raw)
    expect(() => insertProduct(raw, ', badge', `, 'HALF_PRICE'`)).toThrow(/CHECK/)
  })

  it('will not store a rating outside 0 to 5', () => {
    const { raw } = memoryD1()
    seedMerchant(raw)
    expect(() => insertProduct(raw, ', rating', ', 9')).toThrow(/CHECK/)
  })

  it('will not store a review count that is text or negative', () => {
    const { raw } = memoryD1()
    seedMerchant(raw)
    // SQLite's flexible typing stores 'many' in an INTEGER column otherwise.
    expect(() => insertProduct(raw, ', review_count', `, 'many'`)).toThrow(/CHECK/)
    expect(() => insertProduct(raw, ', review_count', ', -1')).toThrow(/CHECK/)
  })

  it('defaults the new columns so an existing row stays legal', () => {
    const { raw, rows } = memoryD1()
    seedMerchant(raw)
    insertProduct(raw, '', '')
    expect(rows('products')[0]).toMatchObject({
      badge: null,
      rating: 0,
      review_count: 0,
      specs_summary: '[]',
    })
  })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm run test -- --run worker/src/tenancy.spec.ts -t "schema refuses"`

Expected: FAIL. The first three throw `no such column: badge` rather than a CHECK error; the fourth fails on the missing keys.

- [ ] **Step 3: Write the migration**

Create `worker/migrations/0007-catalogue-columns.sql`:

```sql
-- The catalogue the storefront already renders does not fit the products table
-- as the tenancy core shipped it. Four fields are missing.
--
-- Columns for what gets filtered or sorted, JSON for what is a document. The
-- catalogue store filters on `badge` (its "deals only" toggle), so badge is a
-- column; specs_summary is three strings nobody queries by field.

ALTER TABLE products ADD COLUMN badge TEXT
  CHECK (badge IS NULL OR badge IN ('NEW_DROP','LIMITED_EDITION','DISCOUNT'));

-- Seed data today, an aggregate over a reviews table later. Never written by a
-- merchant: a seller who can set their own rating makes the platform not a
-- platform, which is why these two are absent from products.update's patch.
ALTER TABLE products ADD COLUMN rating REAL NOT NULL DEFAULT 0
  CHECK (rating >= 0 AND rating <= 5);

ALTER TABLE products ADD COLUMN review_count INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(review_count) = 'integer' AND review_count >= 0);

ALTER TABLE products ADD COLUMN specs_summary TEXT NOT NULL DEFAULT '[]';
```

- [ ] **Step 4: Mirror it in `schema.sql`**

A fresh database is built from `schema.sql`, not from the migrations, so the four columns must appear in the `products` CREATE TABLE with the same constraints. Add them after `stock_count`:

```sql
  badge        TEXT CHECK (badge IS NULL OR badge IN ('NEW_DROP','LIMITED_EDITION','DISCOUNT')),
  rating       REAL NOT NULL DEFAULT 0 CHECK (rating >= 0 AND rating <= 5),
  review_count INTEGER NOT NULL DEFAULT 0
               CHECK (typeof(review_count) = 'integer' AND review_count >= 0),
  specs_summary TEXT NOT NULL DEFAULT '[]',
```

The existing drift test compares `0006` against `schema.sql` and will still pass, because it checks that `schema.sql` *contains* the `0006` block. Do not widen that test to cover `0007` — `0007` is an ALTER and has no matching block. Instead add the note below to the drift test's comment so the next reader knows why coverage stops at `0006`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test -- --run worker/src/tenancy.spec.ts`

Expected: PASS, all tests including the four new ones.

- [ ] **Step 6: Apply to staging and confirm the CHECK bites remotely**

Run: `cd worker && npx wrangler d1 execute nexus-orders-staging --remote --file=migrations/0007-catalogue-columns.sql`

Expected: `success: true`, 4 queries.

Then prove it is not just text:

Run: `npx wrangler d1 execute nexus-orders-staging --remote --command "INSERT INTO merchants (id,slug,name,settlement_currency,status) VALUES ('mch_probe','probe','P','USD','active'); INSERT INTO products (id,merchant_id,sku,title,brand,category,price_minor,currency,status,rating) VALUES ('p_probe','mch_probe','S','T','B','C',1,'USD','draft',9);"`

Expected: refused with `CHECK constraint failed: rating >= 0 AND rating <= 5`.

Then confirm the batch rolled back, so the probe merchant is not left behind:

Run: `npx wrangler d1 execute nexus-orders-staging --remote --command "SELECT COUNT(*) AS n FROM merchants;"`

Expected: `0`.

- [ ] **Step 7: Commit**

```bash
git add worker/migrations/0007-catalogue-columns.sql worker/schema.sql worker/src/tenancy.spec.ts
git commit -m "feat: the products table can hold the catalogue it has to hold

Four fields the storefront already renders had nowhere to live: badge, rating,
review_count, specs_summary. Columns for what gets filtered or sorted, JSON for
what is a document - the same split the tenancy design argued for.

rating and review_count are seed data now and an aggregate later, and they are
never merchant-writable. A seller who can set their own rating makes the
platform not a platform.

ADD COLUMN with a CHECK was verified against real SQLite before being written
here, including that the CHECK refuses a bad insert rather than merely existing."
```

---

### Task 2: Price stops being a float

**Files:**
- Modify: `src/types/index.ts` (the `Product` interface)
- Modify: `src/data/products.ts` (the `Draft` type and the mapping)
- Modify: every consumer of `Product.price` — find them with the command in Step 2
- Test: the existing suites cover this; add one guard

**Interfaces:**
- Produces: `Product.priceMinor: number`. Tasks 3, 6, 7 and 8 all assume it.

`Product.price` is the last float in the money path, tolerated by a comment saying it is "never used for arithmetic". D1 stores `price_minor`. Doing this before the seed means the generator writes integers without a conversion step that could round.

- [ ] **Step 1: Find every consumer**

Run: `grep -rn "\.price\b" src/ worker/ --include=*.ts --include=*.vue`

Write the list down before changing anything. Every hit is either an arithmetic use (becomes `priceMinor`) or a display use (becomes `priceMinor` passed to the formatter).

- [ ] **Step 2: Write the failing guard test**

Create `src/lib/money.spec.ts` additions, or append to the existing money spec:

```ts
import { products } from '@/data/products'

it('every catalogue price is a whole number of minor units', () => {
  // A float here is how 899.95 * 3 becomes 2699.8500000000004. The catalogue
  // was the last place one survived.
  for (const p of products) {
    expect(Number.isSafeInteger(p.priceMinor)).toBe(true)
  }
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm run test -- --run src/lib/money.spec.ts`

Expected: FAIL — `priceMinor` is undefined, so `Number.isSafeInteger(undefined)` is false.

- [ ] **Step 4: Change the type**

In `src/types/index.ts`, replace the `price` field:

```ts
  /** Minor units of `currency`. Divided only by the display formatter. */
  priceMinor: number
```

In `src/data/products.ts`, change `Draft.price: number` to `priceMinor: number`, convert every literal (`price: 899.95` becomes `priceMinor: 89995`), and change the mapping to `priceMinor: d.priceMinor`.

- [ ] **Step 5: Follow the compiler**

Run: `npm run typecheck`

Fix every error it names. Sorting comparators use `priceMinor` directly; display sites pass `priceMinor` to the existing formatter. `worker/src/orders.ts:29`'s `Math.round(p.price * 100)` becomes `p.priceMinor` with the `Math.round` deleted — that rounding existed only to undo the float.

- [ ] **Step 6: Run everything**

Run: `npm run test && npm run typecheck`

Expected: all green, typecheck exit 0.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: the catalogue speaks minor units

Product.price was the last float in the money path, kept alive by a comment
promising it was never used for arithmetic. It was used for arithmetic - in
orders.ts, where Math.round(p.price * 100) existed purely to undo it.

Doing this before the catalogue moves into D1 means the seed generator writes
integers rather than converting them, so there is no rounding step to get wrong."
```

---

### Task 3: Merchants and the catalogue, seeded into D1

**Files:**
- Create: `scripts/seed-catalogue.mjs`
- Create: `worker/migrations/0008-seed-catalogue.sql` (its output, committed)
- Test: `worker/src/catalogue.spec.ts` (new, seeded from the migration)

**Interfaces:**
- Consumes: `Product.priceMinor` from Task 2; the columns from Task 1.
- Produces: merchants keyed by brand id, and 45 product rows. Task 5 reads them, Task 7's generator reads them back out.

The direction of this arrow reverses exactly once and never points back:

```
step 1   hand-written products.ts  ──→  0008-seed-catalogue.sql  ──→  D1
step 2   D1  ──→  build-catalog.mjs  ──→  generated products.ts     (Task 7)
```

- [ ] **Step 1: Write the generator**

Create `scripts/seed-catalogue.mjs`:

```js
/**
 * One-time: turn the hand-written catalogue into a migration.
 *
 * Run once, commit the output, never run again — after Task 7 the arrow
 * reverses and products.ts is generated FROM the database. Re-running this
 * later would seed D1 from a file D1 itself produced.
 */
import { writeFileSync } from 'node:fs'
import { products } from '../src/data/products.ts'
import { brands } from '../src/data/brands.ts'

const q = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`)

const merchants = [...new Set(products.map((p) => p.brand))].map((id) => {
  const brand = brands.find((b) => b.id === id)
  if (!brand) throw new Error(`no brand record for ${id}`)
  return { id: `mch_${id}`, slug: id, name: brand.name }
})

const lines = [
  '-- Generated once by scripts/seed-catalogue.mjs. Do not hand-edit; do not',
  '-- regenerate. After the build-catalog generator lands, products.ts is',
  '-- produced FROM this data, and re-running the seed would close a loop.',
  '--',
  '-- One merchant per brand. These are demo entities in a portfolio project,',
  '-- not a claim of any commercial relationship. Every merchant settles in USD;',
  '-- multi-currency belongs to the money and FX plan, and seeding one currency',
  '-- means the first FX bug is found by that plan rather than hidden here.',
  '',
]

for (const m of merchants) {
  lines.push(
    `INSERT INTO merchants (id, slug, name, settlement_currency, status) VALUES ` +
      `(${q(m.id)}, ${q(m.slug)}, ${q(m.name)}, 'USD', 'active');`,
  )
}
lines.push('')

for (const p of products) {
  lines.push(
    `INSERT INTO products (id, merchant_id, sku, title, brand, category, price_minor,` +
      ` currency, status, stock_count, badge, rating, review_count, specs, colorways,` +
      ` media, specs_summary) VALUES (` +
      [
        q(p.id),
        q(`mch_${p.brand}`),
        q(p.sku),
        q(p.title),
        q(p.brand),
        q(p.category),
        p.priceMinor,
        q(p.currency),
        `'published'`,
        p.stockCount,
        q(p.badge ?? null),
        p.rating,
        p.reviewCount,
        q(JSON.stringify(p.specs)),
        q(JSON.stringify(p.colorways)),
        q(JSON.stringify(p.media)),
        q(JSON.stringify(p.specsSummary)),
      ].join(', ') +
      ');',
  )
}

writeFileSync('worker/migrations/0008-seed-catalogue.sql', lines.join('\n') + '\n')
console.log(`wrote ${merchants.length} merchants and ${products.length} products`)
```

- [ ] **Step 2: Run it**

Run: `node --experimental-strip-types scripts/seed-catalogue.mjs`

Expected: `wrote N merchants and 45 products`. If the import of a `.ts` file fails under the installed Node, convert the two imports to read the built output instead — do not hand-write the SQL.

- [ ] **Step 3: Write the failing test**

Create `worker/src/catalogue.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { memoryD1 } from '../test/d1-memory'

/** The seed migration loaded into a real database, statement by statement. */
function seeded() {
  const mem = memoryD1()
  const sql = readFileSync('worker/migrations/0008-seed-catalogue.sql', 'utf8')
  for (const stmt of sql.split(';\n')) {
    if (stmt.replace(/--[^\n]*/g, '').trim()) mem.raw.prepare(stmt).run()
  }
  return mem
}

describe('the seeded catalogue', () => {
  it('gives every product a merchant that exists', () => {
    const { raw } = seeded()
    const orphans = raw
      .prepare(
        `SELECT p.id FROM products p LEFT JOIN merchants m ON m.id = p.merchant_id
          WHERE m.id IS NULL`,
      )
      .all()
    expect(orphans).toEqual([])
  })

  it('seeds 45 published products', () => {
    const { raw } = seeded()
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM products`).get()).toEqual({ n: 45 })
    expect(
      raw.prepare(`SELECT COUNT(*) AS n FROM products WHERE status = 'published'`).get(),
    ).toEqual({ n: 45 })
  })

  it('spreads them across more than one merchant', () => {
    // A single tenant makes scopedTo and platformWide return the same thing,
    // and the isolation this project built stops being visible at all.
    const { raw } = seeded()
    const { n } = raw.prepare(`SELECT COUNT(DISTINCT merchant_id) AS n FROM products`).get()
    expect(n).toBeGreaterThan(1)
  })

  it('stores prices as whole minor units', () => {
    const { raw } = seeded()
    const bad = raw
      .prepare(`SELECT id FROM products WHERE typeof(price_minor) != 'integer'`)
      .all()
    expect(bad).toEqual([])
  })
})
```

- [ ] **Step 4: Run it**

Run: `npm run test -- --run worker/src/catalogue.spec.ts`

Expected: PASS. If a CHECK from Task 1 refuses a row, the seed generator is producing a value the schema rejects — fix the generator, regenerate, do not relax the CHECK.

- [ ] **Step 5: Apply to staging**

Run: `cd worker && npx wrangler d1 execute nexus-orders-staging --remote --file=migrations/0008-seed-catalogue.sql`

Expected: `success: true`.

Run: `npx wrangler d1 execute nexus-orders-staging --remote --command "SELECT merchant_id, COUNT(*) n FROM products GROUP BY merchant_id ORDER BY n DESC;"`

Expected: several merchants, counts summing to 45.

- [ ] **Step 6: Commit**

```bash
git add scripts/seed-catalogue.mjs worker/migrations/0008-seed-catalogue.sql worker/src/catalogue.spec.ts
git commit -m "feat: the catalogue exists in the database

One merchant per brand, 45 products, all published and all in USD. Generated
from the hand-written catalogue rather than typed out, because 45 INSERTs
written by hand is not a reviewable artifact.

The generator runs exactly once. After build-catalog lands, products.ts is
produced FROM the database, and re-running the seed would close a loop between
a file and its own source."
```

---

### Task 4: `order_lines` learns which product, and whose

**Files:**
- Create: `worker/migrations/0009-order-lines-product-id.sql`
- Modify: `worker/schema.sql` (the `order_lines` table)
- Test: `worker/src/catalogue.spec.ts` (append)

**Interfaces:**
- Produces: `order_lines.product_id`, `order_lines.merchant_id`, and the primary key `(order_id, product_id, variant)`. Task 6 writes them.

Changing a primary key is not an `ALTER TABLE` in SQLite. The table is rebuilt inside one `--file` import, so the whole thing is all-or-nothing.

**The backfill window is closing.** Existing rows carry `sku` and no `product_id`. That derivation is unambiguous only while SKU is still globally unique, which is true today and stops being true the first time a second merchant lists the same SKU. A row that cannot be resolved must abort the import rather than be copied with a guess: an order line pointing at the wrong merchant's product falsifies a transaction that really happened.

- [ ] **Step 1: Find out how many rows are at stake**

Run: `cd worker && npx wrangler d1 execute nexus-orders --remote --command "SELECT (SELECT COUNT(*) FROM orders) orders, (SELECT COUNT(*) FROM order_lines) lines;"`

Staging is known to be 0. If production is also 0 the migration is a formality; if it is not, rehearse Step 4 against a local copy first. **This command reads production — if the harness refuses it, stop and ask the user to run it.** Do not proceed on an assumption about the number.

- [ ] **Step 2: Write the failing test**

Append to `worker/src/catalogue.spec.ts`:

```ts
describe('order lines name their product', () => {
  const rebuild = (mem: ReturnType<typeof memoryD1>) => {
    const sql = readFileSync('worker/migrations/0009-order-lines-product-id.sql', 'utf8')
    for (const stmt of sql.split(';\n')) {
      if (stmt.replace(/--[^\n]*/g, '').trim()) mem.raw.prepare(stmt).run()
    }
  }

  it('carries an existing line across by resolving its sku', () => {
    const mem = seeded()
    const { raw } = mem
    const p = raw.prepare(`SELECT id, sku, merchant_id FROM products LIMIT 1`).get() as {
      id: string; sku: string; merchant_id: string
    }
    raw.prepare(`INSERT INTO orders (id, email, ship_name, ship_line1, ship_city, ship_state,
                                     ship_postal, method, subtotal_cents, shipping_cents,
                                     tax_cents, total_cents, payment_status)
                 VALUES ('o1','a@b.c','N','L','C','S','P','standard',1,0,0,1,'succeeded')`).run()
    raw.prepare(`INSERT INTO order_lines (order_id, sku, title, qty, unit_price_cents)
                 VALUES ('o1', ?, 'T', 1, 100)`).run(p.sku)

    rebuild(mem)

    expect(raw.prepare(`SELECT product_id, merchant_id FROM order_lines`).get()).toEqual({
      product_id: p.id,
      merchant_id: p.merchant_id,
    })
  })

  it('refuses to guess when a sku resolves to nothing', () => {
    const mem = seeded()
    mem.raw.prepare(`INSERT INTO orders (id, email, ship_name, ship_line1, ship_city, ship_state,
                                         ship_postal, method, subtotal_cents, shipping_cents,
                                         tax_cents, total_cents, payment_status)
                     VALUES ('o1','a@b.c','N','L','C','S','P','standard',1,0,0,1,'succeeded')`).run()
    mem.raw.prepare(`INSERT INTO order_lines (order_id, sku, title, qty, unit_price_cents)
                     VALUES ('o1','SKU-THAT-NEVER-EXISTED','T',1,100)`).run()

    // Copying this row with a NULL or invented product_id would write a false
    // record of a real transaction.
    expect(() => rebuild(mem)).toThrow()
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm run test -- --run worker/src/catalogue.spec.ts -t "order lines"`

Expected: FAIL — `ENOENT` on the migration file, which does not exist yet.

- [ ] **Step 4: Write the migration**

Create `worker/migrations/0009-order-lines-product-id.sql`:

```sql
-- UNIQUE (merchant_id, sku) was right, and it demoted sku from an identity to
-- an attribute. The order pipeline was keyed on it, so the key has to move.
--
-- A primary key change is a table rebuild in SQLite, not an ALTER. This whole
-- file lands through the --file import, which is all-or-nothing, so a failure
-- leaves order_lines exactly as it was.
--
-- The backfill resolves sku -> product. That is unambiguous only while sku is
-- still globally unique, which is true today and false the first time two
-- merchants list the same one. NOT NULL on product_id is what turns an
-- unresolvable row into an aborted import rather than a falsified order line.

CREATE TABLE order_lines_new (
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
  unit_price_cents INTEGER NOT NULL,
  variant       TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (order_id, product_id, variant)
);

INSERT INTO order_lines_new (order_id, product_id, merchant_id, sku, title, qty,
                             unit_price_cents, variant)
SELECT l.order_id, p.id, p.merchant_id, l.sku, l.title, l.qty, l.unit_price_cents, l.variant
  FROM order_lines l JOIN products p ON p.sku = l.sku;

DROP TABLE order_lines;

ALTER TABLE order_lines_new RENAME TO order_lines;

CREATE INDEX IF NOT EXISTS order_lines_merchant_idx ON order_lines(merchant_id);
```

The `JOIN` rather than a `LEFT JOIN` is the guard: an unresolvable line is dropped by the SELECT, and the row count then differs from the original. Add the count check as the final statement:

```sql
-- Aborts the whole import if the join lost a row. Without it, an unresolvable
-- line disappears silently, which is the one outcome worse than failing.
INSERT INTO order_lines (order_id, product_id, merchant_id, sku, title, qty,
                         unit_price_cents, variant)
SELECT 'ROLLBACK_GUARD', 'x', 'x', 'x', 'x', -1, 0, ''
 WHERE (SELECT COUNT(*) FROM order_lines) <> (SELECT COUNT(*) FROM order_lines_backup);
```

That guard needs the original count preserved, so capture it first. Put this immediately after the `CREATE TABLE order_lines_new`:

```sql
CREATE TABLE order_lines_backup AS SELECT * FROM order_lines;
```

and drop it at the end:

```sql
DROP TABLE order_lines_backup;
```

The guard row violates `qty > 0`, so the CHECK aborts the import. A guard that fires by breaking a constraint is deliberate: it needs no application code to notice.

- [ ] **Step 5: Mirror in `schema.sql`**

Replace the `order_lines` CREATE TABLE in `worker/schema.sql` with the `order_lines_new` shape above, renamed to `order_lines`, and add the merchant index beside the other indexes. Keep every existing comment.

- [ ] **Step 6: Run the tests**

Run: `npm run test -- --run worker/src/catalogue.spec.ts`

Expected: PASS, both new tests.

- [ ] **Step 7: Apply to staging**

Run: `cd worker && npx wrangler d1 execute nexus-orders-staging --remote --file=migrations/0009-order-lines-product-id.sql`

Expected: `success: true`.

- [ ] **Step 8: Commit**

```bash
git add worker/migrations/0009-order-lines-product-id.sql worker/schema.sql worker/src/catalogue.spec.ts
git commit -m "feat: an order line names its product and its merchant

sku stopped being an identity the moment products gained UNIQUE (merchant_id,
sku). The order pipeline was keyed on it, so the key moves to the catalogue id.

The backfill resolves sku -> product, which is only unambiguous while sku is
still globally unique - true today, false the first time two merchants list the
same one. So it happens here rather than in a later cleanup, and a row that
cannot be resolved aborts the import. An order line pointing at the wrong
merchant's product is a falsified record of a real transaction."
```

---

### Task 5: The public catalogue read

**Files:**
- Create: `worker/src/catalogue.ts`
- Modify: `worker/src/index.ts` (add the route)
- Test: `worker/src/catalogue.spec.ts` (append)

**Interfaces:**
- Produces: `publishedProducts(env: { ORDERS: D1Database }): Promise<CatalogueProduct[]>` and `GET /api/products`. Task 8's overlay fetches it; Task 7's generator calls the same function.

**This read deliberately does not go through `tenancy.ts`.** A shopper is neither a merchant staffer nor platform staff, and a published product is public by definition. Routing it through `platformWide` would write an audit row per visitor, and a third door would destroy the "only two ways in" property the tenancy core exists to hold.

- [ ] **Step 1: Write the failing test**

Append to `worker/src/catalogue.spec.ts`:

```ts
import { publishedProducts } from './catalogue'

describe('publishedProducts', () => {
  it('returns published products from every merchant', async () => {
    const { db, raw } = seeded()
    const rows = await publishedProducts({ ORDERS: db })
    expect(rows).toHaveLength(45)
    const merchants = new Set(rows.map((r) => r.merchantId))
    expect(merchants.size).toBeGreaterThan(1)
  })

  it('hides drafts and archived products from the storefront', async () => {
    const { db, raw } = seeded()
    raw.prepare(`UPDATE products SET status='draft' WHERE id=(SELECT id FROM products LIMIT 1)`).run()
    raw.prepare(`UPDATE products SET status='archived' WHERE id=(SELECT id FROM products LIMIT 1 OFFSET 1)`).run()
    const rows = await publishedProducts({ ORDERS: db })
    expect(rows).toHaveLength(43)
  })

  it('parses the JSON columns rather than handing back strings', async () => {
    const { db } = seeded()
    const [first] = await publishedProducts({ ORDERS: db })
    expect(Array.isArray(first.specsSummary)).toBe(true)
    expect(Array.isArray(first.colorways)).toBe(true)
    expect(typeof first.media).toBe('object')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -- --run worker/src/catalogue.spec.ts -t publishedProducts`

Expected: FAIL — cannot resolve `./catalogue`.

- [ ] **Step 3: Write it**

Create `worker/src/catalogue.ts`:

```ts
/**
 * The storefront's read of the catalogue.
 *
 * This deliberately does NOT go through tenancy.ts. That module's two doors are
 * both for staff — one merchant's data, or the platform's view of everyone's.
 * A shopper is neither, and a published product is public by definition.
 *
 * Routing this through platformWide would write an audit row per visitor, and
 * adding a third door would destroy the "only two ways in" property the tenancy
 * core exists to hold. Someone will eventually try to tidy this away; that is
 * what this comment is for.
 */

export interface CatalogueProduct {
  id: string
  merchantId: string
  sku: string
  title: string
  brand: string
  category: string
  priceMinor: number
  currency: string
  stockCount: number
  badge: string | null
  rating: number
  reviewCount: number
  specs: { label: string; value: string }[]
  specsSummary: string[]
  colorways: { name: string; hex: string }[]
  media: Record<string, unknown>
}

interface Row {
  id: string
  merchant_id: string
  sku: string
  title: string
  brand: string
  category: string
  price_minor: number
  currency: string
  stock_count: number
  badge: string | null
  rating: number
  review_count: number
  specs: string
  specs_summary: string
  colorways: string
  media: string
}

/** JSON columns are stored as text; a bad row must not take the page down. */
const parse = <T>(text: string, fallback: T): T => {
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

export async function publishedProducts(env: { ORDERS: D1Database }): Promise<CatalogueProduct[]> {
  const { results } = await env.ORDERS.prepare(
    `SELECT * FROM products WHERE status = 'published' ORDER BY created_at DESC, id`,
  ).all<Row>()

  return (results ?? []).map((r) => ({
    id: r.id,
    merchantId: r.merchant_id,
    sku: r.sku,
    title: r.title,
    brand: r.brand,
    category: r.category,
    priceMinor: r.price_minor,
    currency: r.currency,
    stockCount: r.stock_count,
    badge: r.badge,
    rating: r.rating,
    reviewCount: r.review_count,
    specs: parse(r.specs, []),
    specsSummary: parse(r.specs_summary, []),
    colorways: parse(r.colorways, []),
    media: parse(r.media, {}),
  }))
}
```

- [ ] **Step 4: Add the route**

In `worker/src/index.ts`, import `publishedProducts` and add beside the other GET routes:

```ts
      /* The catalogue. Public by definition, so no session and no tenancy
         predicate — see the note at the top of catalogue.ts. */
      if (url.pathname === '/api/products' && request.method === 'GET') {
        return json({ products: await publishedProducts(env) }, { headers })
      }
```

- [ ] **Step 5: Run the tests**

Run: `npm run test -- --run worker/src/catalogue.spec.ts && npm run typecheck`

Expected: PASS, typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add worker/src/catalogue.ts worker/src/index.ts worker/src/catalogue.spec.ts
git commit -m "feat: serve the catalogue from the database

GET /api/products, published rows across every merchant.

This read does not go through tenancy.ts and the reason is in the file: both of
that module's doors are for staff, and a shopper is neither kind. Sending it
through platformWide would write an audit row per visitor, and a third door
would cost the property that makes the tenancy core worth having."
```

---

### Task 6: Checkout speaks product id

**Files:**
- Modify: `worker/src/orders.ts`
- Modify: `worker/src/orders.spec.ts` (replace `fakeD1` with `memoryD1`)
- Modify: `src/stores/cart.ts`, `src/stores/checkout.ts`

**Interfaces:**
- Consumes: `order_lines.product_id` from Task 4.
- Produces: the order payload shape `lines: { productId: string; qty: number; finish?: string }[]`.

`orders.spec.ts` currently uses `fakeD1()`, a notebook that records writes and cannot answer a query. It worked because `orders.ts` never read from D1. Once prices come from the database the notebook is no longer a stand-in for anything, so this task switches that suite to `memoryD1()`.

- [ ] **Step 1: Write the failing regression test**

In `worker/src/orders.spec.ts`, add — this is the bug the whole task exists to prevent:

```ts
it('charges each merchant their own price for the same sku', async () => {
  const { db, raw } = memoryD1()
  for (const [mid, slug] of [['mch_a', 'a'], ['mch_b', 'b']]) {
    raw.prepare(`INSERT INTO merchants (id,slug,name,settlement_currency,status)
                 VALUES (?,?,?, 'USD','active')`).run(mid, slug, slug)
  }
  // The same SKU, two merchants, two prices. UNIQUE (merchant_id, sku) permits
  // this on purpose, and it is why a sku-keyed price lookup is a guess.
  raw.prepare(`INSERT INTO products (id,merchant_id,sku,title,brand,category,
                                     price_minor,currency,status,stock_count)
               VALUES ('cheap','mch_a','IP18P-256','A','apple','phones',
                       10000,'USD','published',5)`).run()
  raw.prepare(`INSERT INTO products (id,merchant_id,sku,title,brand,category,
                                     price_minor,currency,status,stock_count)
               VALUES ('dear','mch_b','IP18P-256','B','apple','phones',
                       99900,'USD','published',5)`).run()

  const result = await placeOrder(
    { ORDERS: db },
    { ...validPayload, lines: [{ productId: 'dear', qty: 1 }] },
    null,
  )

  expect(result.status).toBe(201)
  const line = raw.prepare(`SELECT product_id, merchant_id, unit_price_cents FROM order_lines`).get()
  expect(line).toEqual({ product_id: 'dear', merchant_id: 'mch_b', unit_price_cents: 99900 })
})

it('refuses a product id that is not published', async () => {
  const { db, raw } = memoryD1()
  raw.prepare(`INSERT INTO merchants (id,slug,name,settlement_currency,status)
               VALUES ('mch_a','a','A','USD','active')`).run()
  raw.prepare(`INSERT INTO products (id,merchant_id,sku,title,brand,category,
                                     price_minor,currency,status,stock_count)
               VALUES ('draft1','mch_a','S','T','apple','phones',
                       100,'USD','draft',5)`).run()

  const result = await placeOrder(
    { ORDERS: db },
    { ...validPayload, lines: [{ productId: 'draft1', qty: 1 }] },
    null,
  )
  expect(result.status).toBe(400)
})
```

`validPayload` is whatever the existing suite already uses for a good order; reuse it rather than writing a second one.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -- --run worker/src/orders.spec.ts -t "own price"`

Expected: FAIL — `placeOrder` does not know `productId`.

- [ ] **Step 3: Replace the module-level maps with a query**

In `worker/src/orders.ts`, delete the `import { products } from '../../src/data/products'` and the three `*_BY_SKU` maps. Replace the per-line resolution with one query for the whole order:

```ts
/**
 * Resolve every line's product in one statement.
 *
 * This used to be three Maps built once per isolate from a bundled copy of the
 * frontend catalogue. That was fast and wrong twice over: the price went stale
 * until the next deploy, and once two merchants could share a sku the lookup
 * was a guess rather than a lookup.
 */
async function resolve(env: OrdersEnv, ids: string[]) {
  if (!ids.length) return new Map<string, ProductRow>()
  const marks = ids.map(() => '?').join(',')
  const { results } = await env.ORDERS.prepare(
    `SELECT id, merchant_id, sku, title, price_minor, colorways
       FROM products WHERE status = 'published' AND id IN (${marks})`,
  )
    .bind(...ids)
    .all<ProductRow>()
  return new Map((results ?? []).map((r) => [r.id, r]))
}
```

Then in `placeOrder`, read `productId` from each raw line, call `resolve` once, and refuse with `{ status: 400, body: { error: 'unknown product' } }` when an id is missing from the map. Validate the finish against that row's parsed `colorways`. Write `product_id` and `merchant_id` into the `order_lines` insert, and key the duplicate-line check on `${productId}|${finish}`.

- [ ] **Step 4: Switch the suite to a real database**

Replace `fakeD1()` with `memoryD1()` throughout `worker/src/orders.spec.ts`. Every existing test that asserted on recorded `writes` now asserts on rows via `raw.prepare(...)` or `rows('order_lines')`. Any test that relied on `products[0].sku` from the bundled catalogue seeds its own product instead — that import must be gone by the end of this task.

- [ ] **Step 5: Update the frontend payload**

In `src/stores/cart.ts`, add `productId: string` to `CartLine` and set it from `product.id` where the line is built. Change `lineKey` to key on `productId`:

```ts
export const lineKey = (line: Pick<CartLine, 'productId' | 'finish'>) =>
  line.finish ? `${line.productId}|${line.finish}` : line.productId
```

In `src/stores/checkout.ts`, send `productId` instead of `sku` in the order payload. Keep `sku` on the cart line — it is what a customer reads on a receipt.

- [ ] **Step 6: Run everything**

Run: `npm run test && npm run typecheck`

Expected: all green, typecheck exit 0. `grep -rn "PRICE_BY_SKU\|data/products" worker/src/` must return nothing.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: the server prices an order from the database

The price table was three Maps built once per isolate from a bundled copy of
the frontend catalogue. That was wrong twice: the price went stale until the
next deploy, and once two merchants could list one sku the lookup was a guess
that would have charged one merchant's price for another's product, silently.

Lines now carry the catalogue id. The regression test seeds the same sku under
two merchants at two prices and asserts each resolves to its own.

orders.spec.ts moves from a write-recording notebook to real SQLite. The
notebook was adequate only while orders.ts never read anything back."
```

---

### Task 7: The generated catalogue

**Files:**
- Create: `scripts/build-catalog.mjs`
- Replace: `src/data/products.ts` (becomes generated output, still committed)
- Modify: `package.json` (`build` runs the generator first)

**Interfaces:**
- Consumes: `publishedProducts` from Task 5.
- Produces: `src/data/products.ts` exporting `products: Product[]` and `featuredDrop`, exactly as today.

The generated file keeps the same path and the same exports, so **none of the 22 importers change** and first paint is unchanged.

- [ ] **Step 1: Write the generator**

Create `scripts/build-catalog.mjs`. It reads D1 through `wrangler d1 execute --json`, maps rows to the `Product` shape, and writes the file with a banner marking it generated. Include `featuredDrop` by looking up the same SKU the hand-written file used (`DJI-MV4-115`), and fail loudly if it is absent rather than emitting `undefined!`.

```js
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const DB = process.env.CATALOG_DB ?? 'nexus-orders'
const REMOTE = process.env.CATALOG_LOCAL ? [] : ['--remote']

const rows = JSON.parse(
  execFileSync('npx', ['wrangler', 'd1', 'execute', DB, ...REMOTE, '--json',
    '--command', "SELECT * FROM products WHERE status='published' ORDER BY created_at DESC, id"],
    { cwd: 'worker', encoding: 'utf8' }),
)[0].results

if (!rows.length) throw new Error(`${DB} returned no published products`)

const products = rows.map((r) => ({
  id: r.id, sku: r.sku, brand: r.brand, title: r.title, category: r.category,
  priceMinor: r.price_minor, currency: r.currency,
  inStock: r.stock_count > 0, stockCount: r.stock_count,
  badge: r.badge ?? undefined, rating: r.rating, reviewCount: r.review_count,
  specsSummary: JSON.parse(r.specs_summary), specs: JSON.parse(r.specs),
  media: JSON.parse(r.media), colorways: JSON.parse(r.colorways),
}))

const flagship = products.find((p) => p.sku === 'DJI-MV4-115')
if (!flagship) throw new Error('the flagship SKU DJI-MV4-115 is not published')

writeFileSync('src/data/products.ts',
  `// GENERATED by scripts/build-catalog.mjs from D1. Do not edit by hand.\n` +
  `// The database is the source of truth; this file is the build-time snapshot\n` +
  `// that lets the storefront render its first paint without the API.\n` +
  `import type { Product } from '@/types'\n\n` +
  `export const products: Product[] = ${JSON.stringify(products, null, 2)}\n\n` +
  `export const featuredDrop: Product = products.find((p) => p.sku === 'DJI-MV4-115')!\n`)

console.log(`wrote ${products.length} products`)
```

- [ ] **Step 2: Run it against staging**

Run: `CATALOG_DB=nexus-orders-staging node scripts/build-catalog.mjs`

Expected: `wrote 45 products`, and `git diff src/data/products.ts` shows the hand-written file replaced by generated output.

- [ ] **Step 3: Verify nothing downstream noticed**

Run: `npm run test && npm run typecheck`

Expected: all green. This is the real assertion of this task — 22 importers and every existing test still work against a file that is now generated.

- [ ] **Step 4: Wire it into the build**

In the root `package.json`:

```json
"build": "node scripts/build-catalog.mjs && vite build",
"build:staging": "CATALOG_DB=nexus-orders-staging node scripts/build-catalog.mjs && vite build --mode staging",
```

- [ ] **Step 5: Commit**

```bash
git add scripts/build-catalog.mjs src/data/products.ts package.json
git commit -m "feat: generate the catalogue file from the database

src/data/products.ts keeps its path and its exports and is now written by a
script that reads D1. All 22 importers are untouched and first paint is
unchanged, which is the whole reason for choosing generation over a reactive
rewrite of every consumer.

Committed rather than gitignored: a fresh clone stays buildable without D1
credentials, and a catalogue change arrives as a reviewable diff."
```

---

### Task 8: The runtime overlay

**Files:**
- Modify: `src/stores/catalog.ts`
- Test: `src/stores/catalog.spec.ts` (new)

**Interfaces:**
- Consumes: `GET /api/products` from Task 5.
- Produces: `useCatalogStore().items` — the generated snapshot until the fetch lands, the live catalogue afterwards.

Names, prices and stock go live; only the semantic vector for a brand-new product waits for the next deploy. That is the "names are fresh, meanings can be one deploy old" trade the spec settled.

- [ ] **Step 1: Write the failing test**

Create `src/stores/catalog.spec.ts`:

```ts
import { setActivePinia, createPinia } from 'pinia'
import { beforeEach, describe, it, expect, vi } from 'vitest'
import { useCatalogStore } from './catalog'
import { products } from '@/data/products'

describe('the catalogue store', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('renders the baked snapshot before any fetch', () => {
    // The storefront is a static site that must paint without the API.
    expect(useCatalogStore().items).toHaveLength(products.length)
  })

  it('replaces the snapshot once the live catalogue arrives', async () => {
    const store = useCatalogStore()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ products: [{ ...products[0], priceMinor: 1 }] }),
    }))
    await store.refresh()
    expect(store.items).toHaveLength(1)
    expect(store.items[0].priceMinor).toBe(1)
  })

  it('keeps the snapshot when the API is unreachable', async () => {
    const store = useCatalogStore()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await store.refresh()
    // A failed revalidation must not empty the shop.
    expect(store.items).toHaveLength(products.length)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -- --run src/stores/catalog.spec.ts`

Expected: FAIL — `items` and `refresh` do not exist.

- [ ] **Step 3: Add the overlay**

In `src/stores/catalog.ts`, add to state and actions, leaving every existing getter reading `this.items` instead of the imported `products`:

```ts
  state: () => ({
    /* The build-time snapshot, replaced in place once the API answers. */
    items: products as Product[],
    activeFilter: 'all' as Filter,
    // ... existing state
  }),

  actions: {
    /**
     * Revalidate after load.
     *
     * A failure leaves the snapshot in place: a storefront that empties itself
     * because one request failed is worse than one showing a price from the
     * last deploy.
     */
    async refresh() {
      try {
        const res = await fetch(`${import.meta.env.VITE_API_BASE ?? ''}/api/products`)
        if (!res.ok) return
        const body = (await res.json()) as { products: Product[] }
        if (body.products?.length) this.items = body.products
      } catch {
        /* keep the snapshot */
      }
    },
  },
```

Call `refresh()` once from the app's root `onMounted`.

- [ ] **Step 4: Run everything**

Run: `npm run test && npm run typecheck`

Expected: all green, typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/stores/catalog.ts src/stores/catalog.spec.ts src/App.vue
git commit -m "feat: revalidate the catalogue after load

The baked snapshot paints first, the live catalogue replaces it a moment later.
A failed fetch keeps the snapshot, because a shop that empties itself over one
failed request is worse than one showing yesterday's price.

This is the live half of 'names are fresh, meanings can be one deploy old' -
the semantic index still waits for a rebuild, and a new product is findable by
keyword immediately."
```

---

## Self-Review

**Spec coverage.** Section 1 → Tasks 7 and 8. Section 2's columns → Task 1; the seed → Task 3; price as an integer → Task 2. Section 3's merchants → Task 3. Section 4's identity change → Tasks 4 and 6, with the `order_lines` rebuild and its closing backfill window in Task 4. Section 5 → Task 5. Section 6's freshness → Tasks 7 and 8. Section 7's three test groups → Tasks 3, 5, 6, 8.

**Types.** `priceMinor` is introduced in Task 2 and used under that name in Tasks 3, 5, 6, 7 and 8. `publishedProducts` and `CatalogueProduct` are defined in Task 5 and consumed in Task 7. `productId` is the payload field from Task 6 onward and `product_id` the column from Task 4 onward; the two never swap.

**Known gap, deliberately left to the executor.** Task 4 Step 1 needs a production row count this plan's author could not read. If the harness refuses that command, the task stops and asks rather than assuming zero.
