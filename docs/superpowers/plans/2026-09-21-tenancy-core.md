# Tenancy Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give NEXUS a multi-merchant data model in which a merchant-scoped query cannot be written without its tenant predicate, and every platform read of a merchant's data leaves an audit row.

**Architecture:** Four new D1 tables (`merchants`, `staff`, `audit_log`, `products`) where the dangerous states are refused by CHECK constraints and triggers rather than by application code. Above them, a repository factory with two named entry points — `scopedTo(merchantId)` and `platformWide()` — which are the only way to reach the data. Three tests hold the invariant: a poisoned second tenant whose marker must never surface, an audit row required for every platform call, and a completeness test asserting the method list equals the case list.

**Tech Stack:** Cloudflare D1 (SQLite), TypeScript, Vitest, the existing `worker/test/d1-memory.ts` harness that loads the project's real `schema.sql` into `node:sqlite`.

## Global Constraints

- Source of truth for this work: `docs/superpowers/specs/2026-09-21-merchant-admin-design.md`.
- Money is integer minor units. Never a float, never a REAL column.
- Every schema change lands in **both** `worker/schema.sql` and a numbered file in `worker/migrations/`. The test harness loads `schema.sql`; production runs the migration. They drifted three migrations apart once already.
- Migrations are applied to D1 **before** the worker that reads them deploys. Additive columns carry defaults so the running worker is unaffected during the window.
- Tests run with `npm run test -- --run`. Type checking is `npm run typecheck`. Both must pass before any commit.
- No new runtime dependencies.
- Comments explain *why*, in the voice of the surrounding code. No comment restates what the line does.
- This plan covers the tenancy core only. The catalogue migration, the money model and order splitting each get their own plan.

---

## File Structure

| File | Responsibility |
|---|---|
| `worker/migrations/0006-tenancy.sql` (create) | The four tables, their constraints and the audit triggers, as a migration for existing databases |
| `worker/schema.sql` (modify) | The same shapes, for a fresh database and for the test harness |
| `worker/src/tenancy.ts` (create) | `Scope`, the repository factory, `scopedTo`, `platformWide`, `auditedMethods` |
| `worker/src/tenancy.spec.ts` (create) | The three tests that prove isolation |

`tenancy.ts` stays separate from `orders.ts` and `auth.ts`: it is the boundary every future admin query passes through, and a boundary that lives inside a file about something else stops being one.

---

### Task 1: The tables, and the states they refuse

**Files:**
- Create: `worker/migrations/0006-tenancy.sql`
- Modify: `worker/schema.sql`
- Test: `worker/src/tenancy.spec.ts`

**Interfaces:**
- Consumes: `memoryD1()` from `worker/test/d1-memory.ts`, which loads `worker/schema.sql`.
- Produces: tables `merchants`, `staff`, `audit_log`, `products`. Later tasks depend on the column names exactly as written below.

- [ ] **Step 1: Write the failing test**

Create `worker/src/tenancy.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { memoryD1 } from '../test/d1-memory'

/**
 * The constraints are the point of this file, so they are tested directly
 * rather than through the code that relies on them. A CHECK that was never
 * exercised is a comment.
 */
describe('the schema refuses states that must not exist', () => {
  it('will not store a merchant staff row without a merchant', async () => {
    /*
     * The obvious encoding is "merchant_id IS NULL means platform". That is
     * the shape of a privilege-escalation bug: anything that nulls the column
     * issues a platform pass. The paired CHECK makes it unrepresentable.
     */
    const { raw } = memoryD1()
    raw.prepare(`INSERT INTO merchants (id, slug, name, settlement_currency, status)
                 VALUES ('mch_a','a','A','MYR','active')`).run()

    expect(() =>
      raw
        .prepare(
          `INSERT INTO staff (id, email, scope, merchant_id, role, password_hash, password_salt, iterations, kdf_rounds)
           VALUES ('stf_1','a@x.co','merchant',NULL,'owner','h','s',100000,6)`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/)
  })

  it('will not store a platform staff row that belongs to a merchant', async () => {
    const { raw } = memoryD1()
    raw.prepare(`INSERT INTO merchants (id, slug, name, settlement_currency, status)
                 VALUES ('mch_a','a','A','MYR','active')`).run()

    expect(() =>
      raw
        .prepare(
          `INSERT INTO staff (id, email, scope, merchant_id, role, password_hash, password_salt, iterations, kdf_rounds)
           VALUES ('stf_2','b@x.co','platform','mch_a','admin','h','s',100000,6)`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/)
  })

  it('refuses to rewrite or erase the audit log', async () => {
    // A log whose history can be edited is not a log.
    const { raw } = memoryD1()
    raw
      .prepare(
        `INSERT INTO audit_log (id, actor_id, actor_scope, action) VALUES ('aud_1','stf_1','platform','orders.read')`,
      )
      .run()

    expect(() => raw.prepare(`UPDATE audit_log SET action = 'nothing'`).run()).toThrow(
      /append-only/,
    )
    expect(() => raw.prepare(`DELETE FROM audit_log`).run()).toThrow(/append-only/)
  })

  it('keeps sku unique per merchant rather than globally', async () => {
    // Two merchants may both sell IP18P-256. A global unique would make the
    // second merchant to list it unable to.
    const { raw } = memoryD1()
    for (const id of ['mch_a', 'mch_b']) {
      raw
        .prepare(
          `INSERT INTO merchants (id, slug, name, settlement_currency, status) VALUES (?, ?, 'M','MYR','active')`,
        )
        .run(id, id)
    }
    const insert = raw.prepare(
      `INSERT INTO products (id, merchant_id, sku, title, brand, category, price_minor, currency, status)
       VALUES (?, ?, 'IP18P-256','Phone','APPLE','phones',119900,'MYR','published')`,
    )
    insert.run('p_a', 'mch_a')
    expect(() => insert.run('p_b', 'mch_b'), 'a different merchant, same sku').not.toThrow()
    expect(() => insert.run('p_c', 'mch_a'), 'the same merchant twice').toThrow(/UNIQUE/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- --run worker/src/tenancy.spec.ts`

Expected: FAIL — `no such table: merchants`.

- [ ] **Step 3: Add the tables to `worker/schema.sql`**

Append to `worker/schema.sql`:

```sql
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
  price_minor  INTEGER NOT NULL,
  currency     TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('draft','published','archived')),
  stock_count  INTEGER NOT NULL DEFAULT 0,
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- --run worker/src/tenancy.spec.ts`

Expected: PASS, 4 tests.

- [ ] **Step 5: Create the migration for existing databases**

Create `worker/migrations/0006-tenancy.sql` with the identical statements from
Step 3, preceded by this header:

```sql
-- Multi-merchant tenancy: merchants, staff, the audit log and the products
-- table.
--
-- Entirely new tables, so nothing existing is touched and the running worker
-- is unaffected. Apply BEFORE deploying the worker that reads them.
--
--   cd worker
--   npx wrangler d1 execute nexus-orders --remote --file=migrations/0006-tenancy.sql
--   npx wrangler d1 execute nexus-orders-staging --remote --file=migrations/0006-tenancy.sql
```

- [ ] **Step 6: Verify the migration applies to a real database**

Run: `cd worker && npx wrangler d1 execute nexus-orders-staging --remote --file=migrations/0006-tenancy.sql`

Expected: `"success": true`.

Then confirm the constraint survived the round trip:

Run: `npx wrangler d1 execute nexus-orders-staging --remote --command "SELECT sql FROM sqlite_master WHERE name='staff';"`

Expected: the output contains `CHECK ((scope = 'merchant' AND merchant_id IS NOT NULL)`.

- [ ] **Step 7: Commit**

```bash
git add worker/schema.sql worker/migrations/0006-tenancy.sql worker/src/tenancy.spec.ts
git commit -m "feat: the tenancy tables, and the states they refuse to hold

merchants, staff, audit_log and products.

Two constraints carry the weight. staff pairs an explicit scope with a CHECK,
so 'merchant staff with no merchant' and 'platform staff belonging to one'
cannot be inserted — the natural encoding, merchant_id IS NULL meaning
platform, is the shape of a privilege-escalation bug. And audit_log refuses
UPDATE and DELETE outright, because a log whose history can be edited is not
a log.

sku is unique per merchant rather than globally: two merchants may both sell
IP18P-256, and a global unique would stop the second one listing it."
```

---

### Task 2: The repository, and its two named doors

**Files:**
- Create: `worker/src/tenancy.ts`
- Test: `worker/src/tenancy.spec.ts` (append)

**Interfaces:**
- Consumes: the tables from Task 1.
- Produces:
  - `type Scope = { kind: 'merchant'; merchantId: string; staffId: string } | { kind: 'platform'; staffId: string }`
  - `scopedTo(env: TenancyEnv, merchantId: string, staffId: string): Repository`
  - `platformWide(env: TenancyEnv, staffId: string): Repository`
  - `interface Repository { products: { list(): Promise<ProductRow[]>; get(id: string): Promise<ProductRow | null>; create(input: NewProduct): Promise<ProductRow>; update(id: string, patch: ProductPatch): Promise<ProductRow | null> } }`
  - `methodNames(repo: Repository): string[]` — dotted names, e.g. `products.list`

- [ ] **Step 1: Write the failing test**

Append to `worker/src/tenancy.spec.ts`:

```ts
import { scopedTo, platformWide, methodNames, type TenancyEnv } from './tenancy'

/** Two merchants, each with one product. B's is marked so a leak is obvious. */
async function twoTenants() {
  const { db, raw, rows } = memoryD1()
  for (const [id, slug] of [['mch_a', 'a'], ['mch_b', 'b']]) {
    raw
      .prepare(
        `INSERT INTO merchants (id, slug, name, settlement_currency, status) VALUES (?,?,'M','MYR','active')`,
      )
      .run(id, slug)
  }
  raw
    .prepare(
      `INSERT INTO products (id, merchant_id, sku, title, brand, category, price_minor, currency, status)
       VALUES ('p_a','mch_a','SKU-A','Mine','APPLE','phones',100,'MYR','published')`,
    )
    .run()
  raw
    .prepare(
      `INSERT INTO products (id, merchant_id, sku, title, brand, category, price_minor, currency, status)
       VALUES ('LEAK_p_b','mch_b','LEAK_SKU','LEAK_TITLE','SONY','audio',200,'MYR','published')`,
    )
    .run()
  return { env: { ORDERS: db } as TenancyEnv, raw, rows }
}

describe('the repository', () => {
  it('returns only this merchant rows', async () => {
    const { env } = await twoTenants()
    const mine = await scopedTo(env, 'mch_a', 'stf_1').products.list()
    expect(mine.map((p) => p.id)).toEqual(['p_a'])
  })

  it('refuses to fetch another merchant row by id', async () => {
    // Guessing an id must not be a way around the predicate.
    const { env } = await twoTenants()
    expect(await scopedTo(env, 'mch_a', 'stf_1').products.get('LEAK_p_b')).toBeNull()
  })

  it('stamps a created product with the scope merchant, not the input', async () => {
    /*
     * The merchant is taken from the scope and never from the payload. A
     * caller that could name its own merchant_id could write into somebody
     * else's catalogue.
     */
    const { env, rows } = await twoTenants()
    const created = await scopedTo(env, 'mch_a', 'stf_1').products.create({
      sku: 'NEW-1',
      title: 'New',
      brand: 'APPLE',
      category: 'phones',
      priceMinor: 500,
      currency: 'MYR',
    })
    expect(created.merchant_id).toBe('mch_a')
    expect(rows('products').find((p) => p.id === created.id)!.merchant_id).toBe('mch_a')
  })

  it('lets the platform see everything', async () => {
    const { env } = await twoTenants()
    const all = await platformWide(env, 'stf_p').products.list()
    expect(all.map((p) => p.id).sort()).toEqual(['LEAK_p_b', 'p_a'])
  })

  it('lists its own methods, so a test can enumerate them', () => {
    const names = methodNames(scopedTo({} as TenancyEnv, 'mch_a', 'stf_1'))
    expect(names).toContain('products.list')
    expect(names).toContain('products.create')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- --run worker/src/tenancy.spec.ts`

Expected: FAIL — `Failed to resolve import "./tenancy"`.

- [ ] **Step 3: Write the implementation**

Create `worker/src/tenancy.ts`:

```ts
/**
 * The only way into merchant-scoped data.
 *
 * Isolation here is structural rather than disciplinary: there is no function
 * that takes an optional merchant id, and no boolean that widens a query. A
 * caller either holds a merchant-scoped repository or a platform one, and the
 * predicate is attached where the repository is built — not where it is used.
 *
 * SQLite has no row-level security, so this layer is the enforcement point.
 * That is a deliberate trade recorded in the design: Postgres would move the
 * check closer to the data, at the cost of a JWT-minting step that fails in
 * the same way the check was meant to prevent.
 */
import type { OrdersEnv } from './orders'

export interface TenancyEnv extends OrdersEnv {}

export type Scope =
  | { kind: 'merchant'; merchantId: string; staffId: string }
  | { kind: 'platform'; staffId: string }

export interface ProductRow {
  id: string
  merchant_id: string
  sku: string
  title: string
  brand: string
  category: string
  price_minor: number
  currency: string
  status: string
  stock_count: number
  specs: string
  colorways: string
  media: string
}

export interface NewProduct {
  sku: string
  title: string
  brand: string
  category: string
  priceMinor: number
  currency: string
}

export interface ProductPatch {
  title?: string
  priceMinor?: number
  status?: string
  stockCount?: number
}

export interface Repository {
  products: {
    list(): Promise<ProductRow[]>
    get(id: string): Promise<ProductRow | null>
    create(input: NewProduct): Promise<ProductRow>
    update(id: string, patch: ProductPatch): Promise<ProductRow | null>
  }
}

const id = (prefix: string) =>
  `${prefix}_${[...crypto.getRandomValues(new Uint8Array(12))]
    .map((b) => b.toString(36).padStart(2, '0'))
    .join('')
    .slice(0, 20)}`

/**
 * The tenant clause and its binding, or nothing at all.
 *
 * Merchant scope yields the predicate; platform scope yields null and the
 * clause is genuinely absent from the SQL rather than satisfied by a null
 * binding. `WHERE (? IS NULL OR merchant_id = ?)` would be shorter and is the
 * same "null means everything" shape this design rejected in the staff table.
 */
const tenant = (scope: Scope) =>
  scope.kind === 'merchant' ? (['merchant_id = ?', scope.merchantId] as const) : null

/**
 * Assembles clauses into a WHERE and its bindings, in order.
 *
 * Anonymous `?` rather than the numbered `?1` used elsewhere in this worker.
 * The tenant clause is present or absent, and numbering that shifts with it is
 * exactly where an off-by-one silently drops the predicate.
 */
function where(parts: (readonly [string, unknown] | null)[]): { sql: string; args: unknown[] } {
  const live = parts.filter((p): p is readonly [string, unknown] => p !== null)
  return {
    sql: live.length ? ` WHERE ${live.map(([clause]) => clause).join(' AND ')}` : '',
    args: live.map(([, value]) => value),
  }
}

function build(env: TenancyEnv, scope: Scope): Repository {

  return {
    products: {
      async list() {
        const w = where([tenant(scope)])
        const { results } = await env.ORDERS.prepare(
          `SELECT * FROM products${w.sql} ORDER BY created_at DESC`,
        )
          .bind(...w.args)
          .all<ProductRow>()
        return results ?? []
      },

      async get(productId: string) {
        const w = where([['id = ?', productId], tenant(scope)])
        return env.ORDERS.prepare(`SELECT * FROM products${w.sql}`)
          .bind(...w.args)
          .first<ProductRow>()
      },

      async create(input: NewProduct) {
        /*
         * The merchant comes from the scope, never from the payload. A caller
         * that could name its own merchant_id could write into somebody
         * else's catalogue — which is the same hole as a missing predicate,
         * pointed the other way.
         */
        if (scope.kind !== 'merchant') {
          throw new Error('platform scope cannot create a product on a merchant behalf')
        }
        const productId = id('prd')
        await env.ORDERS.prepare(
          `INSERT INTO products (id, merchant_id, sku, title, brand, category, price_minor, currency, status)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'draft')`,
        )
          .bind(
            productId,
            scope.merchantId,
            input.sku,
            input.title,
            input.brand,
            input.category,
            input.priceMinor,
            input.currency,
          )
          .run()
        return (await this.get(productId))!
      },

      async update(productId: string, patch: ProductPatch) {
        const existing = await this.get(productId)
        if (!existing) return null

        // SET bindings come first and the WHERE bindings after, because
        // anonymous `?` binds by position within the whole statement.
        const w = where([['id = ?', productId], tenant(scope)])
        await env.ORDERS.prepare(
          `UPDATE products
              SET title = ?, price_minor = ?, status = ?, stock_count = ?,
                  updated_at = datetime('now')${w.sql}`,
        )
          .bind(
            patch.title ?? existing.title,
            patch.priceMinor ?? existing.price_minor,
            patch.status ?? existing.status,
            patch.stockCount ?? existing.stock_count,
            ...w.args,
          )
          .run()
        return this.get(productId)
      },
    },
  }
}

/** A merchant's own data, and nothing else. */
export const scopedTo = (env: TenancyEnv, merchantId: string, staffId: string): Repository =>
  build(env, { kind: 'merchant', merchantId, staffId })

/**
 * Everything, for platform staff.
 *
 * A separate named door rather than a boolean argument, so that reading a call
 * site tells you which one it is without following a variable.
 */
export const platformWide = (env: TenancyEnv, staffId: string): Repository =>
  build(env, { kind: 'platform', staffId })

/**
 * The dotted names of every method on a repository.
 *
 * Exists for the completeness test: a new method that nobody wrote an
 * isolation case for should turn the suite red on its own.
 */
export function methodNames(repo: Repository): string[] {
  return Object.entries(repo).flatMap(([group, methods]) =>
    Object.keys(methods as object).map((name) => `${group}.${name}`),
  )
}
```

This file uses anonymous `?` while the rest of the worker uses numbered `?1`.
The inconsistency is deliberate and worth it: the tenant clause is present or
absent, and numbering that shifts with it is exactly where an off-by-one drops
the predicate without anything failing. `worker/test/d1-memory.ts` binds
numbered parameters as an object, so it has to handle both — Step 3b.

- [ ] **Step 3b: Teach the test harness to bind positional parameters**

In `worker/test/d1-memory.ts`, replace the body of `run` so both binding styles
work:

```ts
  /**
   * Numbered `?1` binds as an object in node:sqlite; anonymous `?` binds
   * positionally. This worker uses both — tenancy.ts deliberately uses
   * anonymous — so the style is read off the statement rather than assumed.
   */
  const bindArgs = (sql: string, args: unknown[]): unknown[] =>
    /\?\d/.test(sql) ? [named(args)] : args

  const run = (sql: string, args: unknown[]) => {
    const statement = sqlite.prepare(sql)
    if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql)) {
      return {
        results: statement.all(...bindArgs(sql, args)) as Row[],
        meta: { changes: 0 },
        success: true,
      }
    }
    const { changes } = statement.run(...bindArgs(sql, args))
    return { results: [] as Row[], meta: { changes: Number(changes) }, success: true }
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- --run worker/src/tenancy.spec.ts`

Expected: PASS, 9 tests.

Then confirm nothing bound with numbered parameters regressed:

Run: `npm run test -- --run worker/src/auth.spec.ts worker/src/orders.spec.ts`

Expected: PASS, both files.

- [ ] **Step 5: Run the whole suite and the type check**

Run: `npm run typecheck && npm run test -- --run`

Expected: typecheck silent; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add worker/src/tenancy.ts worker/src/tenancy.spec.ts
git commit -m "feat: one door per scope into merchant data

scopedTo(merchantId) and platformWide() return the same interface and differ
only in the predicate attached when the repository is built. There is no
function taking an optional merchant id and no boolean that widens a query,
because a call site should say which one it is without following a variable.

create() takes the merchant from the scope and never from the payload. A
caller that could name its own merchant_id could write into someone else's
catalogue, which is a missing predicate pointed the other way.

methodNames() exists for the completeness test in the next task."
```

---

### Task 3: The poisoned tenant

**Files:**
- Test: `worker/src/tenancy.spec.ts` (append)

**Interfaces:**
- Consumes: `scopedTo`, `methodNames`, `ProductRow` from Task 2; the `twoTenants()` fixture from Task 2's test file, where merchant B's rows are already prefixed `LEAK_`.
- Produces: the constant `CASES`, a map from dotted method name to the arguments that method is called with. Task 5 asserts this map's keys equal `methodNames(...)`.

- [ ] **Step 1: Write the failing test**

Append to `worker/src/tenancy.spec.ts`:

```ts
/**
 * The arguments each method is called with during the isolation sweep.
 *
 * Every method on the repository needs an entry. Task 5 asserts that this
 * map's keys are exactly the repository's method names, so adding a method
 * without adding a case here turns the suite red — which is what makes the
 * sweep below a proof rather than a sample.
 */
const CASES: Record<string, unknown[]> = {
  'products.list': [],
  'products.get': ['LEAK_p_b'],
  'products.create': [
    { sku: 'SWEEP-1', title: 'Sweep', brand: 'APPLE', category: 'phones', priceMinor: 1, currency: 'MYR' },
  ],
  'products.update': ['LEAK_p_b', { title: 'Sweep' }],
}

const call = (repo: Repository, dotted: string, args: unknown[]) => {
  const [group, name] = dotted.split('.')
  const methods = (repo as unknown as Record<string, Record<string, (...a: unknown[]) => unknown>>)[group]
  return methods[name].apply(methods, args)
}

describe('isolation', () => {
  it('never lets one merchant data reach another, through any method', async () => {
    /*
     * Merchant B's rows are seeded with a marker. Rather than knowing the
     * shape of each response, the sweep serialises whatever comes back and
     * asserts the marker is not in it — which holds for a method that has not
     * been written yet as much as for the four that have.
     */
    const { env } = await twoTenants()
    const mine = scopedTo(env, 'mch_a', 'stf_1')

    for (const [dotted, args] of Object.entries(CASES)) {
      const result = await call(mine, dotted, args)
      expect(JSON.stringify(result ?? null), `${dotted} leaked merchant B`).not.toContain('LEAK_')
    }
  })

  it('does not let an update reach across the boundary either', async () => {
    // A write that silently matches nothing is correct; a write that lands on
    // another merchant row is the worst outcome in the system.
    const { env, rows } = await twoTenants()
    await scopedTo(env, 'mch_a', 'stf_1').products.update('LEAK_p_b', { title: 'taken over' })

    const theirs = rows('products').find((p) => p.id === 'LEAK_p_b')!
    expect(theirs.title).toBe('LEAK_TITLE')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails or passes for the right reason**

Run: `npm run test -- --run worker/src/tenancy.spec.ts -t isolation`

Expected: PASS. Task 2 already attaches the predicate, so these tests document
and lock the behaviour rather than drive it.

To confirm they would catch a regression, temporarily change `predicate` in
`worker/src/tenancy.ts` to always return `{ sql: '', args: [] }` and re-run.

Expected: FAIL — `products.list leaked merchant B`.

Restore the function before continuing.

- [ ] **Step 3: Commit**

```bash
git add worker/src/tenancy.spec.ts
git commit -m "test: prove isolation with a poisoned second tenant

Merchant B's rows carry a marker and the sweep serialises whatever each method
returns, asserting the marker never appears. It needs no knowledge of each
response's shape, which is what lets it cover a method that does not exist yet.

Proven to fail: with the predicate stubbed out, products.list leaks B.

Asserting that the generated SQL contains merchant_id was the alternative and
is weaker — 'WHERE x OR merchant_id = ?' passes that, and it tests a string
rather than an outcome."
```

---

### Task 4: Audit every platform read

**Files:**
- Modify: `worker/src/tenancy.ts`
- Test: `worker/src/tenancy.spec.ts` (append)

**Interfaces:**
- Consumes: `build`, `Scope` from Task 2; `audit_log` from Task 1.
- Produces: rows in `audit_log` with `action` set to the dotted method name, `actor_scope` to the scope kind, and `merchant_id` to the merchant whose data was read (null for a platform-wide list).

- [ ] **Step 1: Write the failing test**

Append to `worker/src/tenancy.spec.ts`:

```ts
describe('audit', () => {
  it('records every platform call against merchant data', async () => {
    /*
     * The asymmetry is the design. A merchant reading their own data is not an
     * event; the platform reading it is, and a merchant who cannot see that
     * happen has no reason to trust the platform with their orders.
     */
    const { env, rows } = await twoTenants()
    const platform = platformWide(env, 'stf_p')

    for (const [dotted, args] of Object.entries(CASES)) {
      if (dotted === 'products.create') continue // platform scope refuses this
      await call(platform, dotted, args)
    }

    const actions = rows('audit_log').map((r) => r.action)
    expect(actions).toContain('products.list')
    expect(actions).toContain('products.get')
    expect(rows('audit_log').every((r) => r.actor_scope === 'platform')).toBe(true)
  })

  it('does not record a merchant reading their own data', async () => {
    // Otherwise the log is mostly noise, and the entries that matter are
    // buried in it.
    const { env, rows } = await twoTenants()
    await scopedTo(env, 'mch_a', 'stf_1').products.list()
    expect(rows('audit_log')).toHaveLength(0)
  })

  it('records a merchant write, because every write is an event', async () => {
    const { env, rows } = await twoTenants()
    await scopedTo(env, 'mch_a', 'stf_1').products.update('p_a', { title: 'Renamed' })

    const entry = rows('audit_log')[0]
    expect(entry.action).toBe('products.update')
    expect(entry.actor_scope).toBe('merchant')
    expect(entry.merchant_id).toBe('mch_a')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- --run worker/src/tenancy.spec.ts -t audit`

Expected: FAIL — `expected [] to contain 'products.list'`.

- [ ] **Step 3: Write the implementation**

In `worker/src/tenancy.ts`, add above `build`:

```ts
/** Methods that change something. Everything else is a read. */
const WRITES = new Set(['products.create', 'products.update'])

/**
 * Whether this call is worth a row.
 *
 * Every write by anyone, and every platform read. A merchant reading their own
 * data is not an event, and recording it would bury the entries that are.
 */
const worthAuditing = (scope: Scope, dotted: string): boolean =>
  scope.kind === 'platform' || WRITES.has(dotted)

async function record(
  env: TenancyEnv,
  scope: Scope,
  dotted: string,
  merchantId: string | null,
  subject: string | null,
): Promise<void> {
  await env.ORDERS.prepare(
    `INSERT INTO audit_log (id, actor_id, actor_scope, merchant_id, action, subject)
     VALUES (?1,?2,?3,?4,?5,?6)`,
  )
    .bind(id('aud'), scope.staffId, scope.kind, merchantId, dotted, subject)
    .run()
}
```

Then wrap the returned repository at the end of `build`, replacing
`return { products: { … } }` with a named local and an audited wrapper:

```ts
  const raw: Repository = {
    products: {
      /* …the four methods exactly as written in Task 2… */
    },
  }

  /*
   * Auditing is applied by wrapping rather than by a line inside each method.
   * A line inside each method is a line that can be left out of the next one;
   * the wrapper covers every method the repository has, including the ones
   * nobody has written yet.
   */
  return Object.fromEntries(
    Object.entries(raw).map(([group, methods]) => [
      group,
      Object.fromEntries(
        Object.entries(methods as Record<string, (...a: never[]) => Promise<unknown>>).map(
          ([name, fn]) => [
            name,
            async (...args: never[]) => {
              const result = await fn.apply(methods, args)
              const dotted = `${group}.${name}`
              if (worthAuditing(scope, dotted)) {
                const subject = typeof args[0] === 'string' ? (args[0] as string) : null
                const touched =
                  scope.kind === 'merchant'
                    ? scope.merchantId
                    : ((result as { merchant_id?: string } | null)?.merchant_id ?? null)
                await record(env, scope, dotted, touched, subject)
              }
              return result
            },
          ],
        ),
      ),
    ]),
  ) as Repository
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- --run worker/src/tenancy.spec.ts`

Expected: PASS, all tests in the file.

- [ ] **Step 5: Run the whole suite and the type check**

Run: `npm run typecheck && npm run test -- --run`

Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add worker/src/tenancy.ts worker/src/tenancy.spec.ts
git commit -m "feat: audit every platform read and every write

Applied by wrapping the repository rather than by a line inside each method. A
line inside each method is a line that can be left out of the next one; the
wrapper covers methods nobody has written yet.

Merchant reads of their own data are not recorded. That is not an omission:
the log exists so a merchant can see that NEXUS support read their orders, and
burying those entries under a merchant's own traffic would defeat it."
```

---

### Task 5: The test that makes the other two structural

**Files:**
- Test: `worker/src/tenancy.spec.ts` (append)

**Interfaces:**
- Consumes: `methodNames` from Task 2, `CASES` from Task 3.
- Produces: nothing. This is the guard that keeps Tasks 3 and 4 honest as the repository grows.

- [ ] **Step 1: Write the failing test**

Append to `worker/src/tenancy.spec.ts`:

```ts
describe('completeness', () => {
  it('has an isolation case for every method on the repository', () => {
    /*
     * Without this, the two sweeps above are only as good as somebody's
     * memory, which is the thing this design is trying to remove. Adding
     * db.payouts.list() and forgetting to add a case turns the suite red here
     * rather than leaking in production.
     */
    const methods = methodNames(scopedTo({} as TenancyEnv, 'mch_a', 'stf_1')).sort()
    expect(methods).toEqual(Object.keys(CASES).sort())
  })
})
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `npm run test -- --run worker/src/tenancy.spec.ts -t completeness`

Expected: PASS.

- [ ] **Step 3: Prove it catches an uncovered method**

Temporarily add to the `products` group in `worker/src/tenancy.ts`:

```ts
      async archive(productId: string) {
        return this.update(productId, { status: 'archived' })
      },
```

Run: `npm run test -- --run worker/src/tenancy.spec.ts -t completeness`

Expected: FAIL — the arrays differ by `products.archive`.

Remove the method again before continuing. It belongs to the product-management
plan, not this one.

- [ ] **Step 4: Commit**

```bash
git add worker/src/tenancy.spec.ts
git commit -m "test: the method list must equal the case list

This is what turns the isolation sweep from a sample into a proof. Without it
the sweep covers whatever somebody remembered; with it, a method added without
a case fails here instead of leaking.

Proven to catch it: adding products.archive turns this red."
```

---

### Task 6: Apply to production and confirm the constraints survived

**Files:**
- None. This task is deployment.

**Interfaces:**
- Consumes: `worker/migrations/0006-tenancy.sql` from Task 1.
- Produces: the tables, in the production database.

- [ ] **Step 1: Apply the migration to production D1**

Run: `cd worker && npx wrangler d1 execute nexus-orders --remote --file=migrations/0006-tenancy.sql`

Expected: `"success": true`.

The migration adds tables and touches nothing existing, so the running worker
is unaffected and no deploy has to accompany it.

- [ ] **Step 2: Confirm the paired CHECK exists in production**

Run: `npx wrangler d1 execute nexus-orders --remote --command "SELECT sql FROM sqlite_master WHERE name = 'staff';"`

Expected: output contains `CHECK ((scope = 'merchant' AND merchant_id IS NOT NULL)`.

- [ ] **Step 3: Confirm the audit triggers exist and bite**

Run: `npx wrangler d1 execute nexus-orders --remote --command "INSERT INTO audit_log (id, actor_id, actor_scope, action) VALUES ('aud_probe','stf_probe','platform','probe'); UPDATE audit_log SET action='x' WHERE id='aud_probe';"`

Expected: the INSERT succeeds and the UPDATE fails with `audit log is append-only`.

Because the statements run in one batch, the failure rolls the insert back and
leaves no probe row. Confirm:

Run: `npx wrangler d1 execute nexus-orders --remote --command "SELECT COUNT(*) AS n FROM audit_log;"`

Expected: `0`.

- [ ] **Step 4: Open the pull request**

```bash
git push -u origin feat/tenancy-core
gh pr create --base staging --head feat/tenancy-core \
  --title "feat: the tenancy core" \
  --body "Implements docs/superpowers/plans/2026-09-21-tenancy-core.md.

Four tables, one repository with two named doors, three tests that hold the
isolation invariant.

⚠️ D1 needs migrations/0006-tenancy.sql applied before the worker deploys. It
only adds tables, so the running worker is unaffected during the window."
```

---

## Self-Review

**Spec coverage.** Section 3 of the spec is covered by Tasks 1–5: `merchants`,
`staff` with the paired CHECK, the append-only `audit_log`, the scope type, the
asymmetry between merchant and platform auditing, and the per-merchant sku
uniqueness noted under "consequences for existing code". Section 5's three
tests are Tasks 3, 4 and 5.

Not covered here, by design, and each needing its own plan: the catalogue
migration and the build-time snapshot (spec section 4), the money model and FX
(section 2), order splitting (section 3), the console SPA and its auth (section
1), and `domain/` extraction — which is deferred until something outside
`worker/` needs the shared code, rather than done speculatively.

**Placeholders.** None. Every step carries the code or the command it needs.

**Type consistency.** `Scope`, `Repository`, `ProductRow`, `NewProduct`,
`ProductPatch`, `TenancyEnv`, `scopedTo`, `platformWide` and `methodNames` are
defined in Task 2 and used with those exact names in Tasks 3, 4 and 5. `CASES`
and `call` are defined in Task 3 and used in Tasks 4 and 5. The audit columns
written in Task 4 match the table created in Task 1.

**One gap found and closed:** Task 4's wrapper rewrites the object returned by
`build`, so Task 2's implementation must name it `raw` rather than returning
the literal directly. Task 4 Step 3 says so explicitly instead of leaving the
implementer to discover it.
