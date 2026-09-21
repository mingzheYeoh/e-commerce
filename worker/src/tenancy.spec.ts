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

import { scopedTo, platformWide, methodNames, type TenancyEnv, type Repository } from './tenancy'

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
    const created = await scopedTo(env, 'mch_a', 'stf_1').products.create(input as never)
    expect(created.currency).toBe('MYR')

    const createdForB = await scopedTo(env, 'mch_b', 'stf_2').products.create({
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
      scopedTo(env, 'mch_missing', 'stf_1').products.create({
        sku: 'NEW-4',
        title: 'New',
        brand: 'APPLE',
        category: 'phones',
        priceMinor: 500,
      }),
    ).rejects.toThrow()
  })

  it('rejects a non-integer priceMinor on create', async () => {
    const { env } = await twoTenants()
    await expect(
      scopedTo(env, 'mch_a', 'stf_1').products.create({
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
    await expect(
      scopedTo(env, 'mch_a', 'stf_1').products.update('p_a', { priceMinor: 19.99 }),
    ).rejects.toThrow()
  })

  it('works when destructured off the repository, not just called as a method', async () => {
    // A normal call style must not depend on `this`.
    const { env } = await twoTenants()
    const { update } = scopedTo(env, 'mch_a', 'stf_1').products
    const result = await update('p_a', { title: 'Renamed' })
    expect(result?.title).toBe('Renamed')
  })

  it('does not let a rebound `this` move a write to a different scope', async () => {
    // `update` no longer reads `this` at all, so calling it with `this`
    // forced to a different repository must behave exactly as if it had been
    // called plainly — the guard and the read always agree, because both
    // come from the same closure that built this particular function.
    const { env, rows } = await twoTenants()
    const platformRepo = platformWide(env, 'stf_p')
    const merchantRepo = scopedTo(env, 'mch_a', 'stf_1')

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
    const all = await platformWide(env, 'stf_p').products.list()
    expect(all.map((p) => p.id).sort()).toEqual(['LEAK_p_b', 'p_a'])
  })

  it('lists its own methods, so a test can enumerate them', () => {
    const names = methodNames(scopedTo({} as TenancyEnv, 'mch_a', 'stf_1'))
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
