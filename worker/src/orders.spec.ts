import { describe, it, expect } from 'vitest'
import { placeOrder, maskEmail, type OrderPayload } from './orders'
import { products } from '../../src/data/products'

/**
 * A D1 stand-in that records what would have been written.
 *
 * The interesting behaviour is everything before the insert — what gets
 * refused, and what number the server arrives at on its own — so the database
 * is a notebook rather than a mock with expectations.
 */
function fakeD1() {
  const writes: { sql: string; args: unknown[] }[] = []
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return { sql, args }
        },
      }
    },
    async batch(stmts: { sql: string; args: unknown[] }[]) {
      writes.push(...stmts)
      return []
    },
  }
  return { env: { ORDERS: db as unknown as D1Database }, writes }
}

const sku = products[0].sku
const unitCents = Math.round(products[0].price * 100)

const payload = (over: Partial<OrderPayload> = {}): OrderPayload => ({
  id: 'NX-4K2P9',
  address: {
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    line1: '12 Analytical Way',
    city: 'Portland',
    state: 'OR',
    postal: '97201',
  },
  method: 'standard',
  lines: [{ sku, qty: 1 }],
  paymentCode: 'succeeded',
  ...over,
})

const orderRow = (writes: { sql: string; args: unknown[] }[]) =>
  writes.find((w) => w.sql.includes('INSERT INTO orders'))!

describe('placeOrder', () => {
  it('stores an order and returns the total it computed itself', async () => {
    const { env, writes } = fakeD1()
    const res = await placeOrder(env, payload())

    expect(res.status).toBe(200)
    // Oregon levies no sales tax, and this product clears the free-shipping bar.
    expect(res.body).toEqual({ id: 'NX-4K2P9', total: unitCents })
    expect(writes).toHaveLength(2)
  })

  it('ignores prices in the request and uses the catalogue', async () => {
    // The whole reason the payload carries no prices. If a caller could name
    // its own, the totals would be whatever it felt like paying.
    const { env, writes } = fakeD1()
    const res = await placeOrder(env, {
      ...payload(),
      lines: [{ sku, qty: 1, unitPriceCents: 1 }],
      totals: { subtotal: 1, shipping: 0, tax: 0, total: 1 },
    } as unknown as OrderPayload)

    expect(res.status).toBe(200)
    expect((res.body as { total: number }).total).toBe(unitCents)
    expect(orderRow(writes).args).toContain(unitCents)
  })

  it('charges tax and shipping the destination actually implies', async () => {
    const { env } = fakeD1()
    const res = await placeOrder(
      env,
      payload({
        address: { ...payload().address, state: 'CA' },
        lines: [{ sku, qty: 1 }],
        method: 'overnight',
      }),
    )
    const total = (res.body as { total: number }).total
    // Overnight is never free, and California is never tax free.
    expect(total).toBe(unitCents + 2995 + Math.round(unitCents * 0.0725))
  })

  it('stores a finish the product is actually sold in', async () => {
    const { env, writes } = fakeD1()
    const finish = products[0].colorways[0].name
    const res = await placeOrder(env, payload({ lines: [{ sku, qty: 1, finish }] as never }))
    expect(res.status).toBe(200)
    const line = writes.find((w) => w.sql.includes('INSERT INTO order_lines'))!
    expect(line.args).toContain(finish)
  })

  it('refuses a finish the product is not sold in', async () => {
    /*
     * Refused rather than quietly dropped. A finish the catalogue does not
     * recognise means the basket and the catalogue disagree, and forgetting it
     * silently is how someone receives the wrong colour.
     */
    const { env, writes } = fakeD1()
    const res = await placeOrder(env, payload({ lines: [{ sku, qty: 1, finish: 'Chartreuse' }] as never }))
    expect(res.status).toBe(400)
    expect(writes).toHaveLength(0)
  })

  it('treats two finishes of one product as two lines', async () => {
    // Keyed on sku alone, ordering a black one and a silver one loses the
    // second — which is why the primary key carries the variant.
    const { env, writes } = fakeD1()
    const [a, b] = products[0].colorways
    const res = await placeOrder(
      env,
      payload({ lines: [{ sku, qty: 1, finish: a.name }, { sku, qty: 1, finish: b.name }] as never }),
    )
    expect(res.status).toBe(200)
    expect(writes.filter((w) => w.sql.includes('INSERT INTO order_lines'))).toHaveLength(2)
  })

  it('still refuses the same product in the same finish twice', async () => {
    const { env } = fakeD1()
    const finish = products[0].colorways[0].name
    const res = await placeOrder(
      env,
      payload({ lines: [{ sku, qty: 1, finish }, { sku, qty: 2, finish }] as never }),
    )
    expect(res.status).toBe(400)
  })

  it('stores an empty string when no finish was chosen', async () => {
    // Not NULL: the column is part of the primary key, and SQLite treats NULLs
    // there as distinct, so the same line could be inserted twice.
    const { env, writes } = fakeD1()
    await placeOrder(env, payload())
    const line = writes.find((w) => w.sql.includes('INSERT INTO order_lines'))!
    expect(line.args[line.args.length - 1]).toBe('')
  })

  it('refuses a sku that is not in the catalogue', async () => {
    const { env, writes } = fakeD1()
    const res = await placeOrder(env, payload({ lines: [{ sku: 'FREE-MONEY-1', qty: 1 }] }))
    expect(res.status).toBe(400)
    expect(writes).toHaveLength(0)
  })

  it('refuses quantities that are negative, fractional or absurd', async () => {
    for (const qty of [0, -3, 1.5, 100, Number.NaN]) {
      const { env } = fakeD1()
      const res = await placeOrder(env, payload({ lines: [{ sku, qty }] }))
      expect(res.status, `qty ${qty} should be refused`).toBe(400)
    }
  })

  it('refuses an id that is not one the client could have drawn', async () => {
    for (const id of ['NX-AAAA', 'nx-4k2p9', "NX-4K2P9'; DROP TABLE orders--", 'NX-I0O1A']) {
      const { env } = fakeD1()
      expect((await placeOrder(env, payload({ id }))).status, id).toBe(400)
    }
  })

  it('refuses a payment code outside the four the schema allows', async () => {
    // A CHECK constraint would catch this, but as a 503 from the database
    // rather than a 400 the caller can act on.
    const { env } = fakeD1()
    expect((await placeOrder(env, payload({ paymentCode: 'definitely_paid' }))).status).toBe(400)
  })

  it('refuses an incomplete address and an unparseable email', async () => {
    const { env } = fakeD1()
    expect((await placeOrder(env, payload({ address: { ...payload().address, city: '' } }))).status).toBe(400)
    expect((await placeOrder(env, payload({ address: { ...payload().address, email: 'ada' } }))).status).toBe(400)
  })

  it('refuses the same sku twice rather than violating the primary key', async () => {
    const { env } = fakeD1()
    const res = await placeOrder(env, payload({ lines: [{ sku, qty: 1 }, { sku, qty: 2 }] }))
    expect(res.status).toBe(400)
  })

  it('reports a repeated order id as a conflict, not a server fault', async () => {
    const env = {
      ORDERS: {
        prepare: () => ({ bind: () => ({}) }),
        batch: async () => {
          throw new Error('D1_ERROR: UNIQUE constraint failed: orders.id')
        },
      } as unknown as D1Database,
    }
    expect((await placeOrder(env, payload())).status).toBe(409)
  })

  it('rejects a body that is not an object at all', async () => {
    const { env } = fakeD1()
    for (const body of [null, 'order', 42, undefined]) {
      expect((await placeOrder(env, body)).status).toBe(400)
    }
  })
})

describe('maskEmail', () => {
  it('leaves enough to recognise and not enough to reconstruct', () => {
    expect(maskEmail('ada@example.com')).toBe('a•••@example.com')
    expect(maskEmail('nonsense')).toBe('•••')
  })
})
