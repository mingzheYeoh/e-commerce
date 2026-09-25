import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { memoryD1 } from '../test/d1-memory'

describe('the migration and the schema', () => {
  it('keeps 0006-tenancy.sql and schema.sql identical', () => {
    /*
     * Every other test in this file runs against schema.sql, because that is
     * what d1-memory loads. The file production actually runs is the
     * migration, and until this test nothing read it at all — so the two
     * could drift and every test would still pass.
     *
     * The \r\n normalisation is load-bearing, not tidiness: these two files
     * have disagreed on line endings before (autocrlf rewrites them per
     * checkout), and a byte-exact guard would go red the first time an editor
     * normalised one of them. A guard that everyone learns to ignore is dead.
     *
     * Coverage stops at 0006 on purpose. 0007 and on are ALTER TABLE
     * migrations with no CREATE TABLE block of their own to slice out and
     * compare — schema.sql instead carries them as the same ALTER statements,
     * appended after the 0006 block ends (inlining their columns into the
     * CREATE TABLE above would edit text this test requires to stay
     * byte-identical to 0006, and immediately fail it). Whether schema.sql
     * still ends up with the columns 0007 promises is exercised by the CHECK
     * tests below, which run against schema.sql directly.
     */
    const norm = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
    const mig = norm('worker/migrations/0006-tenancy.sql')
    expect(norm('worker/schema.sql')).toContain(mig.slice(mig.indexOf('-- A merchant selling')))
  })

  it('keeps 0012 and its block in schema.sql identical', () => {
    // The same guard for the audit paging index: schema.sql carries the
    // migration verbatim, so the index every test runs against is the one the
    // file production runs creates.
    const norm = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n').trim()
    expect(norm('worker/schema.sql')).toContain(norm('worker/migrations/0012-audit-merchant-seq-index.sql'))
  })

  it('keeps 0013 and its block in schema.sql identical', () => {
    // The order lifecycle: every fulfilment, refund and payout test below runs
    // against the tables the production migration creates, not a lookalike.
    const norm = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n').trim()
    expect(norm('worker/schema.sql')).toContain(norm('worker/migrations/0013-order-lifecycle.sql'))
  })

  it('backfills one pending part per merchant of every paid order already stored, and none for a declined one', () => {
    // Replayed against a database that has the orders but not yet the parts,
    // which is where production stands when 0013 runs. Twice, because a
    // migration applied by hand gets applied twice.
    const { raw } = memoryD1()
    for (const m of ['mch_a', 'mch_b']) {
      raw.prepare(`INSERT INTO merchants (id, slug, name, settlement_currency, status) VALUES (?, ?, 'M', 'USD', 'active')`).run(m, m)
    }
    placeOrderRow(raw, 'o_paid')
    placeOrderRow(raw, 'o_declined', '+0 days', 'card_declined')
    addLine(raw, 'o_paid', 'p1', 'mch_a', 'One', 1, 100)
    addLine(raw, 'o_paid', 'p2', 'mch_a', 'Two', 1, 100)
    addLine(raw, 'o_paid', 'p3', 'mch_b', 'Three', 1, 100)
    addLine(raw, 'o_declined', 'p1', 'mch_a', 'One', 1, 100)
    const migration = readFileSync('worker/migrations/0013-order-lifecycle.sql', 'utf8')
    const backfill = migration.slice(migration.indexOf('INSERT OR IGNORE INTO order_fulfilments'))
    raw.prepare(backfill).run()
    raw.prepare(backfill).run()
    expect(raw.prepare(`SELECT order_id, merchant_id, status FROM order_fulfilments ORDER BY merchant_id`).all()).toEqual([
      { order_id: 'o_paid', merchant_id: 'mch_a', status: 'pending' },
      { order_id: 'o_paid', merchant_id: 'mch_b', status: 'pending' },
    ])
    // Every existing merchant takes the default 8%.
    expect(raw.prepare(`SELECT DISTINCT commission_bps FROM merchants`).all()).toEqual([{ commission_bps: 800 }])
  })
})

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

  it('refuses a price or stock that is not a whole, non-negative number', async () => {
    /*
     * INTEGER is an affinity, not a type: SQLite stores 'free' as text and
     * 19.99 as a real in an INTEGER column without complaint. And the
     * application guard is Number.isSafeInteger, which is true of -100000 —
     * so a negative price goes in through the sanctioned door. Both halves
     * belong in the column, where every writer meets them.
     */
    const { raw } = memoryD1()
    raw.prepare(`INSERT INTO merchants (id, slug, name, settlement_currency, status)
                 VALUES ('mch_a','a','A','MYR','active')`).run()

    const insert = (price: unknown, stock: unknown) => () =>
      raw
        .prepare(
          `INSERT INTO products (id, merchant_id, sku, title, brand, category, price_minor, currency, status, stock_count)
           VALUES (?, 'mch_a', ?, 'Phone','APPLE','phones', ?, 'MYR','published', ?)`,
        )
        .run(`p_${String(price)}_${String(stock)}`, `SKU-${String(price)}`, price as never, stock as never)

    expect(insert('free', 0), 'text price').toThrow(/CHECK constraint failed/)
    expect(insert(19.99, 0), 'fractional price').toThrow(/CHECK constraint failed/)
    expect(insert(-100, 0), 'negative price').toThrow(/CHECK constraint failed/)
    expect(insert(100, -1), 'negative stock').toThrow(/CHECK constraint failed/)
    expect(insert(100, 0), 'a whole non-negative pair').not.toThrow()
  })

  it('still defaults stock_count to 0 when it is not supplied', async () => {
    // The CHECK sits on a column with a DEFAULT; a CHECK written against the
    // supplied value rather than the stored one would break the default.
    const { raw, rows } = memoryD1()
    raw.prepare(`INSERT INTO merchants (id, slug, name, settlement_currency, status)
                 VALUES ('mch_a','a','A','MYR','active')`).run()
    raw
      .prepare(
        `INSERT INTO products (id, merchant_id, sku, title, brand, category, price_minor, currency, status)
         VALUES ('p_a','mch_a','SKU-A','Phone','APPLE','phones',100,'MYR','published')`,
      )
      .run()
    expect(rows('products')[0].stock_count).toBe(0)
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
    raw.prepare(`INSERT INTO products (id, merchant_id, sku, title, brand, category,
                                       price_minor, currency, status, badge)
                 VALUES ('p2','mch_a','SKU2','T','B','C',119900,'USD','draft','NEW_DROP')`).run()
  })

  it('will not store a rating outside 0 to 5', () => {
    const { raw } = memoryD1()
    seedMerchant(raw)
    expect(() => insertProduct(raw, ', rating', ', 9')).toThrow(/CHECK/)
    expect(() => insertProduct(raw, ', rating', ', -1')).toThrow(/CHECK/)
  })

  it('will not store a review count that is text or negative', () => {
    const { raw } = memoryD1()
    seedMerchant(raw)
    // SQLite's flexible typing stores 'many' in an INTEGER column otherwise.
    expect(() => insertProduct(raw, ', review_count', `, 'many'`)).toThrow(/CHECK/)
    expect(() => insertProduct(raw, ', review_count', ', -1')).toThrow(/CHECK/)
  })

  it('will not store a display order that is text or negative', () => {
    // The column the catalogue's order rests on, and the one integer column
    // that shipped without this CHECK: `ORDER BY display_order` on a column
    // holding 'abc' sorts it before every number and reshuffles the shop page.
    const { raw } = memoryD1()
    seedMerchant(raw)
    expect(() => insertProduct(raw, ', display_order', `, 'first'`)).toThrow(/CHECK/)
    expect(() => insertProduct(raw, ', display_order', ', -1')).toThrow(/CHECK/)
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

  it('will not store a staff session for a staff member who does not exist', () => {
    const { raw } = memoryD1()
    expect(() =>
      raw.prepare(`INSERT INTO staff_sessions (token_hash, staff_id, expires_at, totp_pending)
                   VALUES ('hash','stf_ghost','2099-01-01T00:00:00Z', 1)`).run(),
    ).toThrow(/FOREIGN KEY/)
  })

  it('will not store a fulfilment state no transition produces, or money that is not whole and positive', () => {
    const { raw } = memoryD1()
    seedMerchant(raw)
    placeOrderRow(raw, 'o1')
    const part = (cols: string, vals: string) => () =>
      raw.prepare(`INSERT INTO order_fulfilments (order_id, merchant_id${cols}) VALUES ('o1','mch_a'${vals})`).run()
    expect(part(', status', `, 'lost'`), 'unknown status').toThrow(/CHECK/)
    expect(part(', status', `, 'shipped'`), 'shipped with no carrier or tracking').toThrow(/CHECK/)
    expect(
      part(', status, carrier, tracking, shipped_at', `, 'delivered', 'UPS', '1Z', datetime('now')`),
      'delivered with no delivery time',
    ).toThrow(/CHECK/)

    const refund = (qty: unknown, amount: unknown) => () =>
      raw
        .prepare(
          `INSERT INTO refunds (id, order_id, merchant_id, product_id, qty, amount_minor, reason, actor_id, actor_scope)
           VALUES (?, 'o1', 'mch_a', 'p1', ?, ?, 'r', 'stf', 'merchant')`,
        )
        .run(`r_${String(qty)}_${String(amount)}`, qty as never, amount as never)
    expect(refund(-1, 100), 'negative units').toThrow(/CHECK/)
    expect(refund(1, 0), 'nothing refunded').toThrow(/CHECK/)
    expect(refund(1, 9.99), 'fractional amount').toThrow(/CHECK/)

    expect(() => raw.prepare(`UPDATE merchants SET commission_bps = 10001`).run()).toThrow(/CHECK/)
    expect(() => raw.prepare(`UPDATE merchants SET commission_bps = -1`).run()).toThrow(/CHECK/)
    const payout = (amount: unknown) => () =>
      raw
        .prepare(`INSERT INTO payouts (id, merchant_id, currency, amount_minor, reference, created_by) VALUES (?, 'mch_a', 'USD', ?, 'r', 's')`)
        .run(`p_${String(amount)}`, amount as never)
    expect(payout(0)).toThrow(/CHECK/)
    expect(payout(1.5)).toThrow(/CHECK/)
  })

  it('refuses to rewrite or erase a refund or a payout', () => {
    // Ledgers, like the audit log: a correction is a new row.
    const { raw } = memoryD1()
    seedMerchant(raw)
    raw.prepare(`INSERT INTO refunds (id, order_id, merchant_id, product_id, qty, amount_minor, reason, actor_id, actor_scope)
                 VALUES ('r1','o1','mch_a','p1',1,100,'r','stf','merchant')`).run()
    raw.prepare(`INSERT INTO payouts (id, merchant_id, currency, amount_minor, reference, created_by)
                 VALUES ('p1','mch_a','USD',100,'r','stf')`).run()
    expect(() => raw.prepare(`UPDATE refunds SET amount_minor = 1`).run()).toThrow(/append-only/)
    expect(() => raw.prepare(`DELETE FROM refunds`).run()).toThrow(/append-only/)
    expect(() => raw.prepare(`UPDATE payouts SET amount_minor = 1`).run()).toThrow(/append-only/)
    expect(() => raw.prepare(`DELETE FROM payouts`).run()).toThrow(/append-only/)
  })

  it('will not store a totp_pending flag that is not 0 or 1', () => {
    // SQLite has no boolean. Without the CHECK, 'yes' and 2 both store, and
    // `totp_pending` is what decides whether a session may act at all.
    const { raw } = memoryD1()
    seedMerchant(raw)
    raw.prepare(`INSERT INTO staff (id, email, scope, merchant_id, role,
                                    password_hash, password_salt, iterations)
                 VALUES ('stf_1','a@b.c','merchant','mch_a','owner','h','s',600000)`).run()
    expect(() =>
      raw.prepare(`INSERT INTO staff_sessions (token_hash, staff_id, expires_at, totp_pending)
                   VALUES ('hash','stf_1','2099-01-01T00:00:00Z', 2)`).run(),
    ).toThrow(/CHECK/)
  })
})

import {
  scopedTo,
  platformWide,
  methodNames,
  utcDay,
  SELF_AUDITED,
  Conflict,
  type TenancyEnv,
  type Repository,
} from './tenancy'

/**
 * Two merchants, each with one product. B's is marked so a leak is obvious.
 * The merchants settle in different currencies on purpose, so a test that
 * asserts a product's currency came from its own merchant can't pass by
 * accident (both being 'MYR' would hide a hardcoded value).
 */
async function twoTenants() {
  const { db, raw, rows } = memoryD1()
  for (const [id, slug, currency] of [
    ['mch_a', 'a', 'MYR'],
    ['mch_b', 'b', 'SGD'],
  ]) {
    raw
      .prepare(
        `INSERT INTO merchants (id, slug, name, settlement_currency, status) VALUES (?,?,'M',?,'active')`,
      )
      .run(id, slug, currency)
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
       VALUES ('LEAK_p_b','mch_b','LEAK_SKU','LEAK_TITLE','LEAK_SONY','LEAK_audio',200,'LEAK_SGD','published')`,
    )
    .run()
  // One order both merchants sold into, and one that is B's alone. B's lines
  // carry the marker, so a leaked line shows up in the sweep below.
  for (const id of ['o_shared', 'LEAK_o_b']) placeOrderRow(raw, id)
  addLine(raw, 'o_shared', 'p_a', 'mch_a', 'Mine', 1, 100)
  addLine(raw, 'o_shared', 'LEAK_p_b', 'mch_b', 'LEAK_LINE', 1, 200)
  addLine(raw, 'LEAK_o_b', 'LEAK_p_b', 'mch_b', 'LEAK_LINE', 1, 200)
  return { env: { ORDERS: db } as TenancyEnv, raw, rows }
}

type Raw = import('node:sqlite').DatabaseSync

/** An order row as checkout writes one, placed `ago` in SQLite's own date modifiers. */
function placeOrderRow(raw: Raw, id: string, ago = '+0 days', payment = 'succeeded') {
  raw
    .prepare(
      `INSERT INTO orders (id, created_at, email, ship_name, ship_phone, ship_line1, ship_city, ship_state,
                           ship_postal, method, subtotal_cents, shipping_cents, tax_cents, total_cents, payment_status)
       VALUES (?, datetime('now', ?), 'buyer@example.com', 'Ada Buyer', '+1 555 0100', '1 Road', 'Town',
               'OR', '97201', 'standard', 0, 0, 0, 0, ?)`,
    )
    .run(id, ago, payment)
}

function addLine(raw: Raw, orderId: string, productId: string, merchantId: string, title: string, qty: number, unit: number) {
  raw
    .prepare(
      `INSERT INTO order_lines (order_id, product_id, merchant_id, sku, title, qty, unit_price_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(orderId, productId, merchantId, `SKU-${productId}`, title, qty, unit)
}

describe('the repository', () => {
  it('returns only this merchant rows', async () => {
    const { env } = await twoTenants()
    const mine = await (await scopedTo(env, 'mch_a', 'stf_1')).products.list()
    expect(mine.map((p) => p.id)).toEqual(['p_a'])
  })

  it('refuses to fetch another merchant row by id', async () => {
    // Guessing an id must not be a way around the predicate.
    const { env } = await twoTenants()
    expect(await (await scopedTo(env, 'mch_a', 'stf_1')).products.get('LEAK_p_b')).toBeNull()
  })

  it('stamps a created product with the scope merchant, not the input', async () => {
    /*
     * The merchant is taken from the scope and never from the payload. A
     * caller that could name its own merchant_id could write into somebody
     * else's catalogue.
     */
    const { env, rows } = await twoTenants()
    const created = await (await scopedTo(env, 'mch_a', 'stf_1')).products.create({
      sku: 'NEW-1',
      title: 'New',
      brand: 'APPLE',
      category: 'phones',
      priceMinor: 500,
    })
    expect(created.merchant_id).toBe('mch_a')
    expect(rows('products').find((p) => p.id === created.id)!.merchant_id).toBe('mch_a')
  })

  it('takes currency from the merchant, never the payload', async () => {
    const { env } = await twoTenants()
    // A caller shaped like an attacker trying to name its own currency. Cast
    // past NewProduct, which no longer has the field at all.
    const input = {
      sku: 'NEW-2',
      title: 'New',
      brand: 'APPLE',
      category: 'phones',
      priceMinor: 500,
      currency: 'ZZZ',
    }
    const created = await (await scopedTo(env, 'mch_a', 'stf_1')).products.create(input as never)
    expect(created.currency).toBe('MYR')

    const createdForB = await (await scopedTo(env, 'mch_b', 'stf_2')).products.create({
      sku: 'NEW-3',
      title: 'New',
      brand: 'APPLE',
      category: 'phones',
      priceMinor: 500,
    })
    expect(createdForB.currency).toBe('SGD')
  })

  it('throws creating a product for a merchant that does not exist', async () => {
    const { env } = await twoTenants()
    await expect(
      (async () =>
        (await scopedTo(env, 'mch_missing', 'stf_1')).products.create({
          sku: 'NEW-4',
          title: 'New',
          brand: 'APPLE',
          category: 'phones',
          priceMinor: 500,
        }))(),
    ).rejects.toThrow()
  })

  it('rejects a non-integer priceMinor on create', async () => {
    const { env } = await twoTenants()
    const repo = await scopedTo(env, 'mch_a', 'stf_1')
    await expect(
      repo.products.create({
        sku: 'NEW-5',
        title: 'New',
        brand: 'APPLE',
        category: 'phones',
        priceMinor: 19.99,
      }),
    ).rejects.toThrow()
  })

  it('rejects a non-integer priceMinor on update', async () => {
    const { env } = await twoTenants()
    const repo = await scopedTo(env, 'mch_a', 'stf_1')
    await expect(repo.products.update('p_a', { priceMinor: 19.99 })).rejects.toThrow()
  })

  it('works when destructured off the repository, not just called as a method', async () => {
    // A normal call style must not depend on `this`.
    const { env } = await twoTenants()
    const { update } = (await scopedTo(env, 'mch_a', 'stf_1')).products
    const result = await update('p_a', { title: 'Renamed' })
    expect(result?.title).toBe('Renamed')
  })

  it('does not let a rebound `this` move a write to a different scope', async () => {
    // `update` no longer reads `this` at all, so calling it with `this`
    // forced to a different repository must behave exactly as if it had been
    // called plainly — the guard and the read always agree, because both
    // come from the same closure that built this particular function.
    const { env, rows } = await twoTenants()
    const platformRepo = await platformWide(env, 'stf_p')
    const merchantRepo = await scopedTo(env, 'mch_a', 'stf_1')

    // Platform's own update, `this` forced to a merchant repo: still a
    // platform-scoped read and write, so it still succeeds on any row.
    await platformRepo.products.update.call(merchantRepo.products, 'LEAK_p_b', { title: 'X' })
    expect(rows('products').find((p) => p.id === 'LEAK_p_b')!.title).toBe('X')

    // The merchant repo's own update, `this` forced to the platform repo:
    // still a merchant-scoped read and write, so it still cannot read a row it
    // doesn't own — the borrowed `this` buys it nothing, and returns null.
    const leaked = await merchantRepo.products.update.call(
      platformRepo.products,
      'LEAK_p_b',
      { title: 'Y' },
    )
    expect(leaked, 'pre-fix this returned merchant B whole row').toBeNull()
  })

  it('lets the platform see everything', async () => {
    const { env } = await twoTenants()
    const all = await (await platformWide(env, 'stf_p')).products.list()
    expect(all.map((p) => p.id).sort()).toEqual(['LEAK_p_b', 'p_a'])
  })

  it('lists its own methods, so a test can enumerate them', async () => {
    const { env } = await twoTenants()
    const names = methodNames(await scopedTo(env, 'mch_a', 'stf_1'))
    expect(names).toContain('products.list')
    expect(names).toContain('products.create')
  })
})

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
    { sku: 'SWEEP-1', title: 'Sweep', brand: 'APPLE', category: 'phones', priceMinor: 1 },
  ],
  'products.update': ['LEAK_p_b', { title: 'Sweep' }],
  'products.setMedia': ['LEAK_p_b', '{"gallery":[]}', '{}'],
  'orders.list': [{ from: '2000-01-01', to: '2999-12-31' }],
  'orders.get': ['LEAK_o_b'],
  'stats.overview': [],
  // B's order and B's line: a merchant repository must find neither. The
  // shared order is the sharper case for refunds — A has a line in it, just
  // not this one.
  'fulfilment.ship': ['LEAK_o_b', { carrier: 'Sweep', tracking: 'SWEEP-1' }],
  'fulfilment.deliver': ['LEAK_o_b'],
  'fulfilment.cancel': ['LEAK_o_b'],
  'refunds.create': ['o_shared', { productId: 'LEAK_p_b', variant: '', qty: 1, reason: 'Sweep' }],
  'finance.balance': [],
  // Platform only: a merchant repository has no such groups, which the
  // completeness tests below pin. Suspend before restore, because the audit
  // sweep runs them in this order against an active mch_b.
  'merchants.list': [],
  'merchants.suspend': ['mch_b'],
  'merchants.restore': ['mch_b'],
  'merchants.setCommission': ['mch_b', 900],
  'audit.list': [{ merchantId: null, before: null }],
  'payouts.create': ['mch_a', { currency: 'MYR', amountMinor: 1, reference: 'Sweep' }],
}

/** Everything in CASES that a merchant repository does not carry at all. */
const PLATFORM_ONLY = [
  'merchants.list',
  'merchants.suspend',
  'merchants.restore',
  'merchants.setCommission',
  'audit.list',
  'payouts.create',
]

/** Methods the platform repository carries and refuses: they act for one merchant, which the platform is not. */
const MERCHANT_ACTS = ['products.create', 'fulfilment.ship', 'fulfilment.deliver', 'fulfilment.cancel']

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
    const mine = await scopedTo(env, 'mch_a', 'stf_1')

    for (const dotted of methodNames(mine)) {
      const result = await call(mine, dotted, CASES[dotted])
      expect(JSON.stringify(result ?? null), `${dotted} leaked merchant B`).not.toContain('LEAK_')
    }
  })

  it('does not let an update reach across the boundary either', async () => {
    // A write that silently matches nothing is correct; a write that lands on
    // another merchant row is the worst outcome in the system.
    const { env, rows } = await twoTenants()
    await (await scopedTo(env, 'mch_a', 'stf_1')).products.update('LEAK_p_b', { title: 'taken over' })

    const theirs = rows('products').find((p) => p.id === 'LEAK_p_b')!
    expect(theirs.title).toBe('LEAK_TITLE')
  })

  it('does not let a fulfilment change or a refund reach across the boundary', async () => {
    // B's parts exist and are pending; A aims every new write at them.
    const { env, raw, rows } = await twoTenants()
    raw.prepare(`INSERT INTO order_fulfilments (order_id, merchant_id) VALUES ('o_shared','mch_b'), ('LEAK_o_b','mch_b')`).run()
    const a = await scopedTo(env, 'mch_a', 'stf_1')
    for (const orderId of ['o_shared', 'LEAK_o_b']) {
      expect(await a.fulfilment.ship(orderId, { carrier: 'X', tracking: 'Y' })).toBeNull()
      expect(await a.fulfilment.cancel(orderId)).toBeNull()
      expect(await a.fulfilment.deliver(orderId)).toBeNull()
      expect(await a.refunds.create(orderId, { productId: 'LEAK_p_b', variant: '', qty: 1, reason: 'x' })).toBeNull()
    }
    expect(rows('order_fulfilments').map((f) => f.status)).toEqual(['pending', 'pending'])
    expect(rows('refunds')).toEqual([])
    expect(rows('audit_log')).toEqual([])
  })

  it('does not let a media write reach across the boundary', async () => {
    const { env, rows } = await twoTenants()
    const before = rows('products').find((p) => p.id === 'LEAK_p_b')!.media
    const res = await (await scopedTo(env, 'mch_a', 'stf_1')).products.setMedia('LEAK_p_b', '{"x":1}', before as string)
    expect(res).toBeNull()
    expect(rows('products').find((p) => p.id === 'LEAK_p_b')!.media).toBe(before)
  })
})

describe('audit', () => {
  it('records every platform call against merchant data', async () => {
    /*
     * The asymmetry is the design. A merchant reading their own data is not an
     * event; the platform reading it is, and a merchant who cannot see that
     * happen has no reason to trust the platform with their orders.
     */
    const { env, rows } = await twoTenants()
    const platform = await platformWide(env, 'stf_p')

    for (const [dotted, args] of Object.entries(CASES)) {
      if (MERCHANT_ACTS.includes(dotted)) {
        // Platform scope refuses these outright, and records nothing for them.
        await expect(call(platform, dotted, args), dotted).rejects.toThrow()
        continue
      }
      await call(platform, dotted, args)
    }

    const actions = rows('audit_log').map((r) => r.action)
    expect(actions).toContain('products.list')
    expect(actions).toContain('products.get')
    expect(rows('audit_log').every((r) => r.actor_scope === 'platform')).toBe(true)

    // The platform's merchant_id column is derived from the row that was
    // actually read, not from the scope (platform has none) or left null.
    const getEntry = rows('audit_log').find((r) => r.action === 'products.get')!
    expect(getEntry.merchant_id).toBe('mch_b')
    expect(getEntry.subject).toBe('LEAK_p_b')
  })

  it('names every merchant a platform list touched, one row each', async () => {
    /*
     * A list returns an array, so a single row derived from `result` lands
     * with merchant_id NULL — and the merchant-facing query the
     * audit_merchant_idx exists to serve (`WHERE merchant_id = ?`) returns
     * nothing for the single broadest platform read of their data. Each
     * merchant must be able to find the read in their own log.
     */
    const { env, raw } = await twoTenants()
    await (await platformWide(env, 'stf_p')).products.list()

    // The merchant-facing query, run as a merchant's own console would.
    const theirLog = raw.prepare(`SELECT action FROM audit_log WHERE merchant_id = ?`)
    for (const merchantId of ['mch_a', 'mch_b']) {
      expect(
        theirLog.all(merchantId).map((r) => (r as { action: string }).action),
        `${merchantId} cannot see the platform read of their catalogue`,
      ).toEqual(['products.list'])
    }
  })

  it('does not record a merchant reading their own data', async () => {
    // Otherwise the log is mostly noise, and the entries that matter are
    // buried in it.
    const { env, rows } = await twoTenants()
    await (await scopedTo(env, 'mch_a', 'stf_1')).products.list()
    expect(rows('audit_log')).toHaveLength(0)
  })

  it('names what a create created, since the row can never be amended', async () => {
    // create's first argument is the payload, not an id, so a subject read
    // off the arguments is null — and the one row that brings an object into
    // existence would be the only one that cannot say which object.
    const { env, rows } = await twoTenants()
    const created = await (await scopedTo(env, 'mch_a', 'stf_1')).products.create({
      sku: 'NEW-6',
      title: 'New',
      brand: 'APPLE',
      category: 'phones',
      priceMinor: 500,
    })

    const entry = rows('audit_log').find((r) => r.action === 'products.create')!
    expect(entry.subject).toBe(created.id)
  })

  it('records a merchant write, because every write is an event', async () => {
    const { env, rows } = await twoTenants()
    await (await scopedTo(env, 'mch_a', 'stf_1')).products.update('p_a', { title: 'Renamed' })

    const entry = rows('audit_log')[0]
    expect(entry.action).toBe('products.update')
    expect(entry.actor_scope).toBe('merchant')
    expect(entry.merchant_id).toBe('mch_a')
  })
})

describe('completeness', () => {
  it('has an isolation case for every method on the repository', async () => {
    /*
     * Without this, the two sweeps above are only as good as somebody's
     * memory, which is the thing this design is trying to remove. Adding
     * db.payouts.list() and forgetting to add a case turns the suite red here
     * rather than leaking in production.
     */
    const { env } = await twoTenants()
    const methods = methodNames(await scopedTo(env, 'mch_a', 'stf_1')).sort()
    expect(methods).toEqual(Object.keys(CASES).filter((m) => !PLATFORM_ONLY.includes(m)).sort())
  })

  it('has an audit case for every method on the platform repository', async () => {
    const { env } = await twoTenants()
    expect(methodNames(await platformWide(env, 'stf_p')).sort()).toEqual(Object.keys(CASES).sort())
  })

  it('gives a merchant repository no way to suspend, restore or read the audit log', async () => {
    // Structural, not a refusal: the method is not there to call.
    const { env } = await twoTenants()
    const mine = await scopedTo(env, 'mch_a', 'stf_1')
    expect('merchants' in mine).toBe(false)
    expect('audit' in mine).toBe(false)
  })
})

const db4 = (db: D1Database): TenancyEnv => ({ ORDERS: db })

describe('a merchant who is not active', () => {
  const seed = (status: string) => {
    const mem = memoryD1()
    mem.raw.prepare(`INSERT INTO merchants (id, slug, name, settlement_currency, status)
                     VALUES ('mch_a','a','A','USD', ?)`).run(status)
    mem.raw.prepare(`INSERT INTO products (id, merchant_id, sku, title, brand, category,
                                           price_minor, currency, status, stock_count)
                     VALUES ('p1','mch_a','S','T','B','C',100,'USD','published',1)`).run()
    return mem
  }

  it('hands out no repository at all while the application is pending', async () => {
    // Refused here rather than at the route, so a route added later inherits it
    // without its author having to know this rule exists.
    const { db } = seed('pending')
    await expect(scopedTo(db4(db), 'mch_a', 'stf_1')).rejects.toThrow(/not active/i)
  })

  it('hands out no repository once a merchant is suspended', async () => {
    const { db } = seed('suspended')
    await expect(scopedTo(db4(db), 'mch_a', 'stf_1')).rejects.toThrow(/not active/i)
  })

  it('hands one out for an active merchant', async () => {
    const { db } = seed('active')
    const repo = await scopedTo(db4(db), 'mch_a', 'stf_1')
    expect(await repo.products.list()).toHaveLength(1)
  })

  it('refuses a merchant id that does not exist', async () => {
    const { db } = seed('active')
    await expect(scopedTo(db4(db), 'mch_ghost', 'stf_1')).rejects.toThrow(/not active/i)
  })
})

/**
 * Two merchants in two currencies, and orders whose sums are worked out by
 * hand in the comments. Every expected number below is arithmetic on this
 * table, not a value read back from the code under test.
 *
 *   A (USD): pa1 1000 published stock 3 · pa2 2500 published stock 10 · pa3 draft
 *   B (SGD): pb1 700 published stock 50
 *
 *   o1 today      pa1 x2 = 2000 USD, pb1 x1 = 700 SGD   shared
 *   o2 3 days     pa2 x1 = 2500 USD
 *   o3 10 days    pa1 x1 = 1000, pa2 x2 = 5000 USD
 *   o4 40 days    pa1 x5 = 5000 USD                      outside 30 days
 *   o5 today      pa2 x1, card declined                   never revenue
 *   o6 today      pb1 x3 = 2100 SGD
 */
function sales() {
  const { db, raw, rows } = memoryD1()
  for (const [id, currency] of [
    ['mch_a', 'USD'],
    ['mch_b', 'SGD'],
  ]) {
    raw
      .prepare(`INSERT INTO merchants (id, slug, name, settlement_currency, status) VALUES (?, ?, ?, ?, 'active')`)
      .run(id, id, id.toUpperCase(), currency)
  }
  const product = raw.prepare(
    `INSERT INTO products (id, merchant_id, sku, title, brand, category, price_minor, currency, status, stock_count)
     VALUES (?, ?, ?, ?, 'B', 'phones', ?, ?, ?, ?)`,
  )
  product.run('pa1', 'mch_a', 'A1', 'Alpha One', 1000, 'USD', 'published', 3)
  product.run('pa2', 'mch_a', 'A2', 'Alpha Two', 2500, 'USD', 'published', 10)
  product.run('pa3', 'mch_a', 'A3', 'Alpha Draft', 900, 'USD', 'draft', 0)
  product.run('pb1', 'mch_b', 'B1', 'Beta One', 700, 'SGD', 'published', 50)

  placeOrderRow(raw, 'o1')
  addLine(raw, 'o1', 'pa1', 'mch_a', 'Alpha One', 2, 1000)
  addLine(raw, 'o1', 'pb1', 'mch_b', 'Beta One', 1, 700)
  placeOrderRow(raw, 'o2', '-3 days')
  addLine(raw, 'o2', 'pa2', 'mch_a', 'Alpha Two', 1, 2500)
  placeOrderRow(raw, 'o3', '-10 days')
  addLine(raw, 'o3', 'pa1', 'mch_a', 'Alpha One', 1, 1000)
  addLine(raw, 'o3', 'pa2', 'mch_a', 'Alpha Two', 2, 2500)
  placeOrderRow(raw, 'o4', '-40 days')
  addLine(raw, 'o4', 'pa1', 'mch_a', 'Alpha One', 5, 1000)
  placeOrderRow(raw, 'o5', '+0 days', 'card_declined')
  addLine(raw, 'o5', 'pa2', 'mch_a', 'Alpha Two', 1, 2500)
  placeOrderRow(raw, 'o6')
  addLine(raw, 'o6', 'pb1', 'mch_b', 'Beta One', 3, 700)
  return { env: { ORDERS: db } as TenancyEnv, raw, rows }
}

const ALL_TIME = { from: '2000-01-01', to: '2999-12-31' }

describe('a shared order', () => {
  it('shows each merchant its own lines and its own sum, never the other merchant or the order total', async () => {
    const { env } = await sales()
    const a = await (await scopedTo(env, 'mch_a', 'stf_a')).orders.get('o1')
    const b = await (await scopedTo(env, 'mch_b', 'stf_b')).orders.get('o1')

    expect(a!.lines.map((l) => l.product_id)).toEqual(['pa1'])
    expect(a!.totals).toEqual([{ currency: 'USD', minor: 2000 }])
    expect(b!.lines.map((l) => l.product_id)).toEqual(['pb1'])
    expect(b!.totals).toEqual([{ currency: 'SGD', minor: 700 }])
    // Both still get what they need to ship, and nothing to contact anyone by.
    expect(a).toMatchObject({ ship_name: 'Ada Buyer', ship_postal: '97201', method: 'standard' })
    expect(JSON.stringify(a)).not.toMatch(/buyer@example\.com|555 0100|Beta One|pb1/)
    expect(JSON.stringify(b)).not.toMatch(/buyer@example\.com|555 0100|Alpha One|pa1/)
  })

  it('lists the shared order to both, each summed over its own lines', async () => {
    const { env } = await sales()
    const a = await (await scopedTo(env, 'mch_a', 'stf_a')).orders.list(ALL_TIME)
    const b = await (await scopedTo(env, 'mch_b', 'stf_b')).orders.list(ALL_TIME)
    // Newest first; o5 was declined, so it is nobody's order to fulfil.
    expect(a.map((o) => o.id)).toEqual(['o1', 'o2', 'o3', 'o4'])
    expect(a[0]).toMatchObject({ items: 2, totals: [{ currency: 'USD', minor: 2000 }] })
    expect(a[2]).toMatchObject({ items: 3, totals: [{ currency: 'USD', minor: 6000 }] })
    expect(b.map((o) => o.id).sort()).toEqual(['o1', 'o6'])
    expect(b.find((o) => o.id === 'o1')).toMatchObject({ items: 1, totals: [{ currency: 'SGD', minor: 700 }] })
  })

  it("keeps each merchant's revenue to its own lines", async () => {
    const { env } = await sales()
    const a = await (await scopedTo(env, 'mch_a', 'stf_a')).stats.overview()
    const b = await (await scopedTo(env, 'mch_b', 'stf_b')).stats.overview()
    expect(a.revenue.today).toEqual([{ currency: 'USD', minor: 2000 }])
    // 700 from the shared order and 2100 from o6, and none of A's 2000.
    expect(b.revenue.today).toEqual([{ currency: 'SGD', minor: 2800 }])
  })

  it('refuses another merchant its orders by id, and filters by date', async () => {
    const { env } = await sales()
    const a = await scopedTo(env, 'mch_a', 'stf_a')
    expect(await a.orders.get('o6')).toBeNull()
    expect(await a.orders.get('o5'), 'a declined attempt is not an order').toBeNull()
    expect(await a.orders.get('no-such-order')).toBeNull()
    // The last two days only: o1 today; o2 is three days back.
    const recent = await a.orders.list({ from: utcDay(1), to: utcDay(0) })
    expect(recent.map((o) => o.id)).toEqual(['o1'])
  })
})

describe('the overview', () => {
  it("adds up a merchant's own sales by hand-checked windows", async () => {
    const { env } = await sales()
    const o = await (await scopedTo(env, 'mch_a', 'stf_a')).stats.overview()

    // today: o1 2000. 7 days: + o2 2500. 30 days: + o3 6000. o4 is outside, o5 declined.
    expect(o.revenue).toEqual({
      today: [{ currency: 'USD', minor: 2000 }],
      week: [{ currency: 'USD', minor: 4500 }],
      month: [{ currency: 'USD', minor: 10500 }],
    })
    expect(o.orders).toEqual({ today: 1, week: 2, month: 3 })

    expect(o.trend).toHaveLength(30)
    expect(o.trend[29]).toEqual({ day: utcDay(0), revenue: [{ currency: 'USD', minor: 2000 }] })
    expect(o.trend.find((d) => d.day === utcDay(3))!.revenue).toEqual([{ currency: 'USD', minor: 2500 }])
    expect(o.trend.find((d) => d.day === utcDay(10))!.revenue).toEqual([{ currency: 'USD', minor: 6000 }])
    expect(o.trend.filter((d) => d.revenue.length).map((d) => d.day)).toEqual([utcDay(10), utcDay(3), utcDay(0)])

    // pa2: 2500 + 5000 = 7500 over 3 units. pa1: 2000 + 1000 = 3000 over 3.
    expect(o.top).toEqual([
      { product_id: 'pa2', title: 'Alpha Two', currency: 'USD', minor: 7500, qty: 3 },
      { product_id: 'pa1', title: 'Alpha One', currency: 'USD', minor: 3000, qty: 3 },
    ])
    // Published and at most five: pa1 at 3. The draft at 0 is not on sale.
    expect(o.lowStock).toEqual([{ id: 'pa1', title: 'Alpha One', stock_count: 3 }])
    expect(o.products).toEqual({ draft: 1, published: 2, archived: 0 })
  })

  it('never adds two currencies together, platform-wide', async () => {
    const { env } = await sales()
    const o = await (await platformWide(env, 'stf_p')).stats.overview()
    expect(o.revenue.month).toEqual([
      { currency: 'SGD', minor: 2800 },
      { currency: 'USD', minor: 10500 },
    ])
    // o1, o2, o3, o6. o1 counts once although two merchants sold into it.
    expect(o.orders).toEqual({ today: 2, week: 3, month: 4 })
    expect(o.trend[29].revenue).toEqual([
      { currency: 'SGD', minor: 2800 },
      { currency: 'USD', minor: 2000 },
    ])
    // Ranked within each currency, since 7500 cents and 2800 cents are not comparable.
    expect(o.top.map((t) => [t.currency, t.product_id])).toEqual([
      ['SGD', 'pb1'],
      ['USD', 'pa2'],
      ['USD', 'pa1'],
    ])
  })

  it('lists every merchant with its product count and 30-day revenue', async () => {
    const { env, raw } = await sales()
    raw.prepare(`INSERT INTO merchants (id, slug, name, settlement_currency, status) VALUES ('mch_p','p','P','USD','pending')`).run()
    const list = await (await platformWide(env, 'stf_p')).merchants.list()
    const by = Object.fromEntries(list.map((m) => [m.merchant_id, m]))
    expect(by.mch_a).toMatchObject({ status: 'active', product_count: 3, revenue: [{ currency: 'USD', minor: 10500 }] })
    expect(by.mch_b).toMatchObject({ status: 'active', product_count: 1, revenue: [{ currency: 'SGD', minor: 2800 }] })
    expect(by.mch_p).toMatchObject({ status: 'pending', product_count: 0, revenue: [] })
  })
})

describe('suspending a merchant', () => {
  it('suspends and restores, auditing each against the merchant', async () => {
    const { env, rows } = await sales()
    const platform = await platformWide(env, 'stf_p')
    await platform.merchants.suspend('mch_b')
    expect(rows('merchants').find((m) => m.id === 'mch_b')!.status).toBe('suspended')
    await platform.merchants.restore('mch_b')
    expect(rows('merchants').find((m) => m.id === 'mch_b')!.status).toBe('active')

    const log = rows('audit_log').map((r) => [r.action, r.merchant_id, r.subject, r.actor_id, r.actor_scope])
    expect(log).toEqual([
      ['merchants.suspend', 'mch_b', 'mch_b', 'stf_p', 'platform'],
      ['merchants.restore', 'mch_b', 'mch_b', 'stf_p', 'platform'],
    ])
  })

  it('never touches a pending application, and writes no audit row for the refusal', async () => {
    const { env, raw, rows } = await sales()
    raw.prepare(`INSERT INTO merchants (id, slug, name, settlement_currency, status) VALUES ('mch_p','p','P','USD','pending')`).run()
    const platform = await platformWide(env, 'stf_p')
    await expect(platform.merchants.suspend('mch_p')).rejects.toThrow(/is not active/)
    await expect(platform.merchants.restore('mch_p')).rejects.toThrow(/is not suspended/)
    await expect(platform.merchants.restore('mch_a'), 'already active').rejects.toThrow(/is not suspended/)
    expect(rows('merchants').find((m) => m.id === 'mch_p')!.status).toBe('pending')
    expect(rows('audit_log')).toEqual([])
  })

  it("closes the suspended merchant's own door", async () => {
    const { env } = await sales()
    await (await platformWide(env, 'stf_p')).merchants.suspend('mch_a')
    await expect(scopedTo(env, 'mch_a', 'stf_a')).rejects.toThrow(/not active/)
  })

  it('leaves the status alone when its audit row cannot be written', async () => {
    // The change and its row are one batch. A trigger stands in for any
    // failure of the INSERT: the UPDATE before it must roll back with it.
    const { env, raw, rows } = await sales()
    const breakAudit = () =>
      raw.prepare(`CREATE TRIGGER audit_down BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit down'); END`).run()
    const mendAudit = () => raw.prepare(`DROP TRIGGER audit_down`).run()
    const platform = await platformWide(env, 'stf_p')

    breakAudit()
    await expect(platform.merchants.suspend('mch_a')).rejects.toThrow(/audit down/)
    expect(rows('merchants').find((m) => m.id === 'mch_a')!.status).toBe('active')

    mendAudit()
    await platform.merchants.suspend('mch_a')
    breakAudit()
    await expect(platform.merchants.restore('mch_a')).rejects.toThrow(/audit down/)
    expect(rows('merchants').find((m) => m.id === 'mch_a')!.status).toBe('suspended')
  })

  it('is recorded by its own batch only, never again by the wrapper', () => {
    // Exactly the writes that insert their own row; the first test in this
    // block would count four rows instead of two if the wrapper also did.
    expect([...SELF_AUDITED].sort()).toEqual([
      'fulfilment.cancel',
      'fulfilment.deliver',
      'fulfilment.ship',
      'merchants.restore',
      'merchants.setCommission',
      'merchants.suspend',
      'payouts.create',
      'refunds.create',
    ])
  })
})

describe('the audit log', () => {
  /** `count` rows, alternately B's and A's, all in the same second: ties only rowid can order. */
  const seedLog = (raw: Raw, count: number, from = 0) => {
    const insert = raw.prepare(
      `INSERT INTO audit_log (id, at, actor_id, actor_scope, merchant_id, action)
       VALUES (?, '2026-01-01 00:00:00', 'stf_p', 'platform', ?, 'x')`,
    )
    // Ids that sort the opposite way to their insertion, so an ORDER BY id
    // would show exactly the wrong order.
    for (let i = from; i < from + count; i++) insert.run(`aud_${String(999 - i).padStart(3, '0')}`, i % 2 ? 'mch_a' : 'mch_b')
  }

  async function everyPage(platform: Awaited<ReturnType<typeof platformWide>>, merchantId: string | null, between?: () => void) {
    const seen: string[] = []
    let before: number | null = null
    for (;;) {
      const page = await platform.audit.list({ merchantId, before })
      seen.push(...page.entries.map((e) => e.id))
      if (page.next === null) return seen
      between?.()
      before = page.next
    }
  }

  it('reads newest first in insertion order, even within one second', async () => {
    const { env, raw } = await sales()
    seedLog(raw, 3)
    const page = await (await platformWide(env, 'stf_p')).audit.list({ merchantId: null, before: null })
    // Inserted aud_999, aud_998, aud_997: newest first is the reverse, whatever the ids say.
    expect(page.entries.map((e) => e.id)).toEqual(['aud_997', 'aud_998', 'aud_999'])
    expect(page.next).toBeNull()
  })

  it('pages through every row exactly once while new rows keep arriving', async () => {
    /*
     * Each read writes its own audit.list row, and more are inserted between
     * pages. Under OFFSET both shifted every later page and repeated entries.
     * A cursor on rowid only ever looks further back than it has been.
     */
    const { env, raw } = await sales()
    seedLog(raw, 120)
    let more = 1000
    const seen = await everyPage(await platformWide(env, 'stf_p'), null, () => seedLog(raw, 7, (more += 7)))

    const seeded = Array.from({ length: 120 }, (_, i) => `aud_${String(999 - i).padStart(3, '0')}`).reverse()
    expect(seen.filter((id) => seeded.includes(id))).toEqual(seeded)
    expect(new Set(seen).size, 'no entry shown twice').toBe(seen.length)
  })

  it('pages one merchant through, and only that merchant', async () => {
    const { env, raw } = await sales()
    seedLog(raw, 120)
    const seen = await everyPage(await platformWide(env, 'stf_p'), 'mch_a')
    // A's 60 (the odd ones), newest first. The audit.list rows each page wrote
    // against A are newer than the first page, so no later page reaches them.
    const ofA = Array.from({ length: 120 }, (_, i) => i)
      .filter((i) => i % 2)
      .map((i) => `aud_${String(999 - i).padStart(3, '0')}`)
      .reverse()
    expect(seen).toEqual(ofA)
  })

  it('hands back every merchant name for the filter, and names merchants on entries', async () => {
    const { env, raw } = await sales()
    seedLog(raw, 2)
    const page = await (await platformWide(env, 'stf_p')).audit.list({ merchantId: 'mch_a', before: null })
    expect(page.merchants).toEqual([
      { id: 'mch_a', name: 'MCH_A' },
      { id: 'mch_b', name: 'MCH_B' },
    ])
    expect(page.entries.every((e) => e.merchant_id === 'mch_a' && e.merchant_name === 'MCH_A')).toBe(true)
  })

  it('records one row per read, against the merchant filtered to', async () => {
    // The names ride along with the read; no merchants.list, so no row per merchant.
    const { env, raw } = await sales()
    const platform = await platformWide(env, 'stf_p')
    await platform.audit.list({ merchantId: 'mch_a', before: null })
    await platform.audit.list({ merchantId: null, before: null })
    expect(raw.prepare(`SELECT action, merchant_id FROM audit_log ORDER BY rowid`).all()).toEqual([
      { action: 'audit.list', merchant_id: 'mch_a' },
      // Unfiltered is not one merchant's log: NULL, as documented at drawnOn.
      { action: 'audit.list', merchant_id: null },
    ])
  })

  it('refuses a merchant that does not exist, and records nothing', async () => {
    // It used to read the page, then fail the audit row's foreign key: a 500.
    const { env, rows } = await sales()
    await expect(
      (await platformWide(env, 'stf_p')).audit.list({ merchantId: 'mch_nope', before: null }),
    ).rejects.toThrow(/does not exist/)
    expect(rows('audit_log')).toEqual([])
  })

  it('reads each page by index, never by sorting the whole log', () => {
    // What migration 0012 is for. The unfiltered page seeks on the table's own
    // key; the filtered one on (merchant_id, rowid). A temp B-tree here means a
    // sort of every row the merchant has, on every page.
    const { raw } = memoryD1()
    const plan = (where: string) =>
      (raw.prepare(`EXPLAIN QUERY PLAN SELECT a.rowid FROM audit_log a WHERE ${where} ORDER BY a.rowid DESC LIMIT 51`).all() as {
        detail: string
      }[])
        .map((r) => r.detail)
        .join(' | ')
    expect(plan(`a.rowid < 100`)).not.toMatch(/TEMP B-TREE|SCAN/)
    const filtered = plan(`a.merchant_id = 'm' AND a.rowid < 100`)
    expect(filtered).toContain('audit_merchant_seq_idx')
    expect(filtered).not.toMatch(/TEMP B-TREE/)
  })
})

describe('what a platform read records', () => {
  it('writes every row of a list in one statement, however many merchants it touched', async () => {
    const { env, raw } = await sales()
    for (let i = 0; i < 48; i++) {
      raw.prepare(`INSERT INTO merchants (id, slug, name, settlement_currency, status) VALUES (?, ?, 'M', 'USD', 'active')`).run(`mch_${i}`, `m${i}`)
    }
    const statements: string[] = []
    const counting = {
      ...env.ORDERS,
      prepare: (sql: string) => {
        statements.push(sql)
        return env.ORDERS.prepare(sql)
      },
    } as unknown as D1Database

    const list = await (await platformWide({ ORDERS: counting }, 'stf_p')).merchants.list()
    expect(list).toHaveLength(50)
    expect(statements.filter((s) => /INSERT INTO audit_log/.test(s))).toHaveLength(1)
    // Still one row per merchant, each findable under its own id.
    expect(raw.prepare(`SELECT COUNT(DISTINCT merchant_id) AS n, COUNT(*) AS rows FROM audit_log`).get()).toEqual({ n: 50, rows: 50 })
  })

  it('records the merchants a platform order read drew on, not NULL', async () => {
    const { env, raw } = await sales()
    const platform = await platformWide(env, 'stf_p')
    await platform.orders.list(ALL_TIME)
    const listed = raw.prepare(`SELECT merchant_id FROM audit_log WHERE action = 'orders.list' ORDER BY merchant_id`).all()
    expect(listed).toEqual([{ merchant_id: 'mch_a' }, { merchant_id: 'mch_b' }])

    // o1 is shared: reading it reads both merchants' lines, so both are told.
    await platform.orders.get('o1')
    const got = raw.prepare(`SELECT merchant_id, subject FROM audit_log WHERE action = 'orders.get' ORDER BY merchant_id`).all()
    expect(got).toEqual([
      { merchant_id: 'mch_a', subject: 'o1' },
      { merchant_id: 'mch_b', subject: 'o1' },
    ])
  })

  it('records a platform-wide aggregate once, against NULL meaning every merchant', async () => {
    // Documented at drawnOn: stats.overview is not one merchant's data, and a
    // row per merchant for a single number would be noise that grows with N.
    const { env, raw } = await sales()
    await (await platformWide(env, 'stf_p')).stats.overview()
    expect(raw.prepare(`SELECT action, merchant_id FROM audit_log`).all()).toEqual([
      { action: 'stats.overview', merchant_id: null },
    ])
  })

  it('records nothing for a list that came back empty: it drew on nobody', async () => {
    const { env, rows } = await sales()
    await (await platformWide(env, 'stf_p')).orders.list({ from: '2001-01-01', to: '2001-01-02' })
    expect(rows('audit_log')).toEqual([])
  })
})

/* ---------------------------------------------------------- order lifecycle */

/**
 * sales(), with every paid order's parts opened the way 0013's backfill opens
 * them (the same statement, read from the migration).
 */
function lifecycle() {
  const s = sales()
  const migration = readFileSync('worker/migrations/0013-order-lifecycle.sql', 'utf8')
  s.raw.prepare(migration.slice(migration.indexOf('INSERT OR IGNORE INTO order_fulfilments'))).run()
  const stock = (id: string) =>
    (s.raw.prepare(`SELECT stock_count FROM products WHERE id = ?`).get(id) as { stock_count: number }).stock_count
  const status = (orderId: string, merchantId: string) =>
    (
      s.raw.prepare(`SELECT status FROM order_fulfilments WHERE order_id = ? AND merchant_id = ?`).get(orderId, merchantId) as {
        status: string
      }
    ).status
  const actions = () => s.rows('audit_log').map((r) => r.action)
  /** Every audit INSERT fails from here until mend(): stands in for any failure of the row. */
  const breakAudit = () =>
    s.raw.prepare(`CREATE TRIGGER audit_down BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit down'); END`).run()
  const mend = () => s.raw.prepare(`DROP TRIGGER audit_down`).run()
  return { ...s, stock, status, actions, breakAudit, mend }
}

const refund = (productId: string, qty: number, amountMinor?: number, variant = '') => ({
  productId,
  variant,
  qty,
  amountMinor,
  reason: 'Test',
})

describe('fulfilment', () => {
  it('ships and then delivers its own part, each with its audit row, and leaves the other seller alone', async () => {
    const t = lifecycle()
    const a = await scopedTo(t.env, 'mch_a', 'stf_a')

    const shipped = await a.fulfilment.ship('o1', { carrier: 'UPS', tracking: '1Z999AA10123456784' })
    expect(shipped).toMatchObject({
      order_id: 'o1',
      merchant_id: 'mch_a',
      status: 'shipped',
      carrier: 'UPS',
      tracking: '1Z999AA10123456784',
    })
    expect(shipped!.shipped_at).toBeTruthy()
    expect(t.status('o1', 'mch_b'), "B's part of the shared order").toBe('pending')

    const delivered = await a.fulfilment.deliver('o1')
    expect(delivered).toMatchObject({ status: 'delivered', carrier: 'UPS' })
    expect(delivered!.delivered_at).toBeTruthy()

    expect(t.raw.prepare(`SELECT action, merchant_id, subject, actor_scope, detail FROM audit_log ORDER BY rowid`).all()).toEqual([
      {
        action: 'fulfilment.ship',
        merchant_id: 'mch_a',
        subject: 'o1',
        actor_scope: 'merchant',
        detail: JSON.stringify({ carrier: 'UPS', tracking: '1Z999AA10123456784' }),
      },
      { action: 'fulfilment.deliver', merchant_id: 'mch_a', subject: 'o1', actor_scope: 'merchant', detail: null },
    ])
  })

  it('refuses every transition the state machine does not have, and writes nothing for it', async () => {
    const t = lifecycle()
    const a = await scopedTo(t.env, 'mch_a', 'stf_a')
    const ship = (id: string) => a.fulfilment.ship(id, { carrier: 'DHL', tracking: 'JD01' })

    // pending: deliver is not a step from here.
    await expect(a.fulfilment.deliver('o1')).rejects.toThrow(Conflict)
    await ship('o1')
    // shipped: neither shipped again nor cancelled.
    await expect(ship('o1')).rejects.toThrow(/Only a pending order can be marked shipped; this one is shipped/)
    await expect(a.fulfilment.cancel('o1')).rejects.toThrow(Conflict)
    await a.fulfilment.deliver('o1')
    // delivered: no step leads anywhere from here.
    await expect(a.fulfilment.deliver('o1')).rejects.toThrow(Conflict)
    await expect(a.fulfilment.cancel('o1')).rejects.toThrow(Conflict)
    await expect(ship('o1')).rejects.toThrow(Conflict)

    await a.fulfilment.cancel('o2')
    // cancelled: nothing more.
    await expect(ship('o2')).rejects.toThrow(Conflict)
    await expect(a.fulfilment.deliver('o2')).rejects.toThrow(Conflict)
    await expect(a.fulfilment.cancel('o2')).rejects.toThrow(Conflict)

    expect(t.actions()).toEqual(['fulfilment.ship', 'fulfilment.deliver', 'fulfilment.cancel'])
    expect(t.status('o1', 'mch_a')).toBe('delivered')
    expect(t.status('o2', 'mch_a')).toBe('cancelled')
  })

  it('cancelling puts every unit back and refunds what is left of each line, exactly once', async () => {
    // o3: pa1 x1 at 1000, pa2 x2 at 2500. Stock before: pa1 3, pa2 10.
    const t = lifecycle()
    const a = await scopedTo(t.env, 'mch_a', 'stf_a')
    // One unit of pa2 was already refunded while the order sat pending.
    await a.refunds.create('o3', refund('pa2', 1))

    expect(await a.fulfilment.cancel('o3')).toMatchObject({ status: 'cancelled' })
    // Every unit ordered comes back, the refunded one included: nothing shipped.
    expect([t.stock('pa1'), t.stock('pa2')]).toEqual([4, 12])
    expect(
      t.raw.prepare(`SELECT product_id, qty, amount_minor, reason, actor_scope FROM refunds ORDER BY rowid`).all(),
    ).toEqual([
      { product_id: 'pa2', qty: 1, amount_minor: 2500, reason: 'Test', actor_scope: 'merchant' },
      // The rest: pa1 in full, and pa2's remaining unit.
      { product_id: 'pa1', qty: 1, amount_minor: 1000, reason: 'Order cancelled', actor_scope: 'merchant' },
      { product_id: 'pa2', qty: 1, amount_minor: 2500, reason: 'Order cancelled', actor_scope: 'merchant' },
    ])

    // A second cancel is refused, and restocks and refunds nothing.
    await expect(a.fulfilment.cancel('o3')).rejects.toThrow(Conflict)
    expect([t.stock('pa1'), t.stock('pa2')]).toEqual([4, 12])
    expect(t.rows('refunds')).toHaveLength(3)
    expect(t.actions()).toEqual(['refunds.create', 'fulfilment.cancel'])
  })

  it("answers another merchant's order, a declined one and a missing one with null", async () => {
    const t = lifecycle()
    const a = await scopedTo(t.env, 'mch_a', 'stf_a')
    for (const id of ['o6', 'o5', 'nope']) {
      expect(await a.fulfilment.ship(id, { carrier: 'X', tracking: 'Y' }), id).toBeNull()
      expect(await a.fulfilment.cancel(id), id).toBeNull()
    }
    expect(t.status('o6', 'mch_b')).toBe('pending')
    expect(t.stock('pb1')).toBe(50)
  })

  it('leaves status, stock and refunds untouched when the audit row cannot be written', async () => {
    const t = lifecycle()
    const a = await scopedTo(t.env, 'mch_a', 'stf_a')
    t.breakAudit()
    await expect(a.fulfilment.ship('o1', { carrier: 'UPS', tracking: '1Z' })).rejects.toThrow(/audit down/)
    await expect(a.fulfilment.cancel('o3')).rejects.toThrow(/audit down/)
    expect([t.status('o1', 'mch_a'), t.status('o3', 'mch_a')]).toEqual(['pending', 'pending'])
    expect([t.stock('pa1'), t.stock('pa2')]).toEqual([3, 10])
    expect(t.rows('refunds')).toEqual([])
    t.mend()
    await a.fulfilment.ship('o1', { carrier: 'UPS', tracking: '1Z' })
    t.breakAudit()
    await expect(a.fulfilment.deliver('o1')).rejects.toThrow(/audit down/)
    expect(t.status('o1', 'mch_a')).toBe('shipped')
  })

  it('is a merchant act: the platform repository refuses it outright', async () => {
    const t = lifecycle()
    const platform = await platformWide(t.env, 'stf_p')
    await expect(platform.fulfilment.ship('o1', { carrier: 'UPS', tracking: '1Z' })).rejects.toThrow(/only a merchant/)
    expect(t.status('o1', 'mch_a')).toBe('pending')
  })

  it('shows each order its in-scope parts, in the list and in the detail', async () => {
    const t = lifecycle()
    const a = await scopedTo(t.env, 'mch_a', 'stf_a')
    const platform = await platformWide(t.env, 'stf_p')
    await a.fulfilment.ship('o1', { carrier: 'UPS', tracking: '1Z' })

    expect((await a.orders.list(ALL_TIME)).find((o) => o.id === 'o1')!.fulfilment).toEqual(['shipped'])
    // Ordered by merchant id: mch_a, then mch_b.
    expect((await platform.orders.list(ALL_TIME)).find((o) => o.id === 'o1')!.fulfilment).toEqual(['shipped', 'pending'])

    const mine = await a.orders.get('o1')
    expect(mine!.fulfilment.map((f) => [f.merchant_id, f.status, f.carrier])).toEqual([['mch_a', 'shipped', 'UPS']])
    const all = await platform.orders.get('o1')
    expect(all!.fulfilment.map((f) => [f.merchant_id, f.status])).toEqual([
      ['mch_a', 'shipped'],
      ['mch_b', 'pending'],
    ])
  })
})

describe('refunds', () => {
  it('refunds part of a line and then the rest, never past what was paid, counting every earlier refund', async () => {
    // o3's pa2 line: 2 units at 2500, 5000 paid.
    const t = lifecycle()
    const a = await scopedTo(t.env, 'mch_a', 'stf_a')

    // One unit, priced at the line's own unit price.
    expect(await a.refunds.create('o3', refund('pa2', 1))).toMatchObject({
      qty: 1,
      amount_minor: 2500,
      currency: 'USD',
      merchant_id: 'mch_a',
    })
    // Money only: 2000 of the remaining 2500.
    await a.refunds.create('o3', refund('pa2', 0, 2000))
    // 500 left, and one unit.
    await expect(a.refunds.create('o3', refund('pa2', 0, 501))).rejects.toThrow(/Only 5\.00 USD is left/)
    await expect(a.refunds.create('o3', refund('pa2', 2, 1))).rejects.toThrow(/Only 1 of 2 units/)
    await expect(a.refunds.create('o3', refund('pa2', 1)), 'a unit is 2500, only 500 is left').rejects.toThrow(Conflict)
    await a.refunds.create('o3', refund('pa2', 1, 500))
    // Fully refunded, in units and in money.
    await expect(a.refunds.create('o3', refund('pa2', 0, 1))).rejects.toThrow(Conflict)

    const line = (await a.orders.get('o3'))!.lines.find((l) => l.product_id === 'pa2')!
    expect([line.refunded_qty, line.refunded_minor]).toEqual([2, 5000])
    // pa1 on the same order is its own line with its own cap.
    expect(await a.refunds.create('o3', refund('pa1', 1))).toMatchObject({ amount_minor: 1000 })
    expect(t.actions()).toEqual(['refunds.create', 'refunds.create', 'refunds.create', 'refunds.create'])
  })

  it('holds the cap when another refund lands between the check and the write', async () => {
    // The pre-check reads the ledger, then this refund is raced by one that
    // takes the whole line. The guard reads inside the batch and aborts it.
    const t = lifecycle()
    const batch = t.env.ORDERS.batch.bind(t.env.ORDERS)
    const raced = {
      prepare: t.env.ORDERS.prepare.bind(t.env.ORDERS),
      batch: (async (stmts: D1PreparedStatement[]) => {
        t.raw
          .prepare(
            `INSERT INTO refunds (id, order_id, merchant_id, product_id, variant, qty, amount_minor, reason, actor_id, actor_scope)
             VALUES ('rfd_race','o3','mch_a','pa2','',2,5000,'race','stf_x','merchant')`,
          )
          .run()
        return batch(stmts)
      }) as D1Database['batch'],
    } as unknown as D1Database
    const a = await scopedTo({ ORDERS: raced }, 'mch_a', 'stf_a')
    await expect(a.refunds.create('o3', refund('pa2', 1))).rejects.toThrow(/in the meantime/)
    expect(t.rows('refunds').map((r) => r.id)).toEqual(['rfd_race'])
    expect(t.rows('audit_log')).toEqual([])
  })

  it("finds no line of another merchant's, or of a declined order, or of a finish never sold", async () => {
    const t = lifecycle()
    const a = await scopedTo(t.env, 'mch_a', 'stf_a')
    expect(await a.refunds.create('o1', refund('pb1', 1)), "B's line in the shared order").toBeNull()
    expect(await a.refunds.create('o6', refund('pb1', 1)), "B's order").toBeNull()
    expect(await a.refunds.create('o5', refund('pa2', 1)), 'declined').toBeNull()
    expect(await a.refunds.create('o1', refund('pa1', 1, undefined, 'Gold')), 'no such finish').toBeNull()
    expect(t.rows('refunds')).toEqual([])
  })

  it('lets the platform refund any line, under the same cap, recorded against the seller', async () => {
    const t = lifecycle()
    const platform = await platformWide(t.env, 'stf_p')
    expect(await platform.refunds.create('o1', refund('pb1', 1))).toMatchObject({
      merchant_id: 'mch_b',
      amount_minor: 700,
      currency: 'SGD',
    })
    await expect(platform.refunds.create('o1', refund('pb1', 0, 1))).rejects.toThrow(Conflict)
    expect(t.raw.prepare(`SELECT actor_id, actor_scope, merchant_id FROM refunds`).all()).toEqual([
      { actor_id: 'stf_p', actor_scope: 'platform', merchant_id: 'mch_b' },
    ])
    // One row, written with the refund, and not a second by the wrapper.
    expect(t.raw.prepare(`SELECT action, actor_scope, merchant_id, subject FROM audit_log`).all()).toEqual([
      { action: 'refunds.create', actor_scope: 'platform', merchant_id: 'mch_b', subject: 'o1' },
    ])
  })

  it('writes no refund when its audit row cannot be written', async () => {
    const t = lifecycle()
    const a = await scopedTo(t.env, 'mch_a', 'stf_a')
    t.breakAudit()
    await expect(a.refunds.create('o3', refund('pa2', 1))).rejects.toThrow(/audit down/)
    expect(t.rows('refunds')).toEqual([])
  })
})

describe('balances and payouts', () => {
  /*
   * All time, paid lines only (o5 was declined):
   *   A (USD): o1 2000 + o2 2500 + o3 6000 + o4 5000 = 15500 gross
   *   B (SGD): o1 700 + o6 2100 = 2800 gross
   *
   * Then: A refunds one pa2 unit on o3 (2500) and takes 333 bps; B refunds
   * 1 on o6 at the default 800; A is paid out 5000.
   *
   *   A: net 13000. 13000 × 333 / 10000 = 432.9 → 432. available 13000 − 432 − 5000 = 7568
   *   B: net 2799.  2799 × 800 / 10000 = 223.92 → 223. available 2799 − 223 = 2576
   *
   * The floor is taken once, on the total. Flooring A per line instead —
   * 2000 → 66, 2500 → 83, 1000 → 33, 2500 (net) → 83, 5000 → 166 — gives 431:
   * the figure would depend on how the sales happened to be split.
   */
  async function settled() {
    const t = lifecycle()
    const platform = await platformWide(t.env, 'stf_p')
    await (await scopedTo(t.env, 'mch_a', 'stf_a')).refunds.create('o3', refund('pa2', 1))
    await (await scopedTo(t.env, 'mch_b', 'stf_b')).refunds.create('o6', refund('pb1', 0, 1))
    await platform.merchants.setCommission('mch_a', 333)
    await platform.payouts.create('mch_a', { currency: 'USD', amountMinor: 5000, reference: 'September' })
    return { ...t, platform }
  }

  it('works a hand-computed balance, with commission floored on the total', async () => {
    const { env, platform } = await settled()
    const A = {
      merchant_id: 'mch_a',
      currency: 'USD',
      commission_bps: 333,
      gross: 15500,
      refunds: 2500,
      commission: 432,
      payouts: 5000,
      available: 7568,
    }
    const B = {
      merchant_id: 'mch_b',
      currency: 'SGD',
      commission_bps: 800,
      gross: 2800,
      refunds: 1,
      commission: 223,
      payouts: 0,
      available: 2576,
    }
    expect(await (await scopedTo(env, 'mch_a', 'stf_a')).finance.balance()).toEqual([A])
    expect(await (await scopedTo(env, 'mch_b', 'stf_b')).finance.balance()).toEqual([B])
    expect(await platform.finance.balance()).toEqual([A, B])
  })

  it('keeps each currency its own balance, never adding two together', async () => {
    const { env, raw } = await settled()
    // An SGD product for A: its sale is a second balance, not more USD.
    raw
      .prepare(
        `INSERT INTO products (id, merchant_id, sku, title, brand, category, price_minor, currency, status, stock_count)
         VALUES ('pa_sgd','mch_a','AS','Alpha SGD','B','phones',1000,'SGD','published',5)`,
      )
      .run()
    placeOrderRow(raw, 'o7')
    addLine(raw, 'o7', 'pa_sgd', 'mch_a', 'Alpha SGD', 1, 1000)
    const rows = await (await scopedTo(env, 'mch_a', 'stf_a')).finance.balance()
    expect(rows.map((r) => [r.currency, r.gross, r.available])).toEqual([
      // 1000 × 333 / 10000 = 33.3 → 33.
      ['SGD', 1000, 967],
      ['USD', 15500, 7568],
    ])
  })

  it('refuses a payout over the available balance, and writes nothing for it', async () => {
    const { platform, rows } = await settled()
    const pay = (amountMinor: number, currency = 'USD') =>
      platform.payouts.create('mch_a', { currency, amountMinor, reference: 'October' })
    await expect(pay(7569)).rejects.toThrow(/more than this merchant's available USD balance/)
    await expect(pay(1, 'EUR'), 'a currency it never sold in').rejects.toThrow(Conflict)
    expect(await platform.payouts.create('mch_nope', { currency: 'USD', amountMinor: 1, reference: 'x' })).toBeNull()
    expect(rows('payouts')).toHaveLength(1)
    expect(rows('audit_log').filter((r) => r.action === 'payouts.create')).toHaveLength(1)

    // Exactly the balance is fine, and leaves nothing to pay.
    expect(await pay(7568)).toMatchObject({ merchant_id: 'mch_a', currency: 'USD', amount_minor: 7568, created_by: 'stf_p' })
    await expect(pay(1)).rejects.toThrow(Conflict)
    expect((await platform.finance.balance()).find((b) => b.merchant_id === 'mch_a')!.available).toBe(0)
  })

  it('records a payout and a commission change with their audit rows, or neither', async () => {
    const { platform, raw, rows } = await settled()
    expect(
      raw
        .prepare(
          `SELECT action, merchant_id, detail FROM audit_log
            WHERE action IN ('merchants.setCommission','payouts.create') ORDER BY rowid`,
        )
        .all(),
    ).toEqual([
      { action: 'merchants.setCommission', merchant_id: 'mch_a', detail: JSON.stringify({ from: 800, to: 333 }) },
      {
        action: 'payouts.create',
        merchant_id: 'mch_a',
        detail: JSON.stringify({ currency: 'USD', amount_minor: 5000, reference: 'September' }),
      },
    ])
    raw.prepare(`CREATE TRIGGER audit_down BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit down'); END`).run()
    await expect(platform.payouts.create('mch_a', { currency: 'USD', amountMinor: 1, reference: 'x' })).rejects.toThrow(/audit down/)
    await expect(platform.merchants.setCommission('mch_a', 100)).rejects.toThrow(/audit down/)
    expect(rows('payouts')).toHaveLength(1)
    expect(rows('merchants').find((m) => m.id === 'mch_a')!.commission_bps).toBe(333)
  })

  it('sets commission only within 0 to 10000 bps, and only for a merchant that exists', async () => {
    const { platform, rows } = await settled()
    await expect(platform.merchants.setCommission('mch_a', 10_001)).rejects.toThrow(RangeError)
    await expect(platform.merchants.setCommission('mch_a', 1.5)).rejects.toThrow(RangeError)
    expect(await platform.merchants.setCommission('mch_nope', 100)).toBeNull()
    expect(rows('audit_log').filter((r) => r.action === 'merchants.setCommission')).toHaveLength(1)
  })

  it('audits a platform read of balances against each merchant it read', async () => {
    const { platform, raw } = await settled()
    await platform.finance.balance()
    expect(raw.prepare(`SELECT merchant_id FROM audit_log WHERE action = 'finance.balance' ORDER BY merchant_id`).all()).toEqual([
      { merchant_id: 'mch_a' },
      { merchant_id: 'mch_b' },
    ])
  })
})

describe('revenue after refunds', () => {
  it('reports net sales as revenue and keeps the gross beside it', async () => {
    const t = lifecycle()
    const a = await scopedTo(t.env, 'mch_a', 'stf_a')
    // One of o1's two pa1 units back: today's 2000 becomes 1000 net.
    await a.refunds.create('o1', refund('pa1', 1))
    const o = await a.stats.overview()
    expect(o.revenue.today).toEqual([{ currency: 'USD', minor: 1000 }])
    expect(o.gross.today).toEqual([{ currency: 'USD', minor: 2000 }])
    expect(o.revenue.month).toEqual([{ currency: 'USD', minor: 9500 }])
    expect(o.gross.month).toEqual([{ currency: 'USD', minor: 10500 }])
    expect(o.trend[29].revenue).toEqual([{ currency: 'USD', minor: 1000 }])
    // Ranked on net: pa1 is 3000 − 1000.
    expect(o.top.find((p) => p.product_id === 'pa1')).toMatchObject({ minor: 2000, qty: 3 })
    // Still counted as an order: it was placed and paid.
    expect(o.orders.today).toBe(1)

    const list = await (await platformWide(t.env, 'stf_p')).merchants.list()
    expect(list.find((m) => m.merchant_id === 'mch_a')!.revenue).toEqual([{ currency: 'USD', minor: 9500 }])
  })
})
