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
    country: 'US',
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

  it('files the order to the signed-in account, and to nobody otherwise', async () => {
    /*
     * The account link comes from the session, which the caller reads from a
     * cookie — never from the payload. A request that could name its own owner
     * could file its order into someone else's history.
     */
    const signedIn = fakeD1()
    await placeOrder(signedIn.env, payload(), 'usr_abc')
    expect(orderRow(signedIn.writes).args).toContain('usr_abc')

    const guest = fakeD1()
    await placeOrder(guest.env, payload())
    expect(orderRow(guest.writes).args.at(-1)).toBeNull()
  })
})

describe('placeOrder addresses', () => {
  const at = (over: Record<string, unknown>) =>
    payload({ address: { ...payload().address, ...over } as never })

  it('accepts an address from any country the store ships to', async () => {
    const { env, writes } = fakeD1()
    const res = await placeOrder(env, at({ country: 'MY', state: 'SGR', postal: '50450' }))
    expect(res.status).toBe(200)
    expect(orderRow(writes).args).toContain('MY')
  })

  it('charges the destination its own tax, not an American one', async () => {
    // The whole reason country reaches totalCents. Before this, a Malaysian
    // order was charged 6% US default sales tax under a "Tax" label.
    const { env } = fakeD1()
    const res = await placeOrder(env, at({ country: 'MY', state: 'SGR', postal: '50450' }))
    expect((res.body as { total: number }).total).toBe(unitCents + Math.round(unitCents * 0.08))
  })

  it('refuses a country the store does not ship to', async () => {
    const { env, writes } = fakeD1()
    const res = await placeOrder(env, at({ country: 'ZZ' }))
    expect(res.status).toBe(400)
    expect(writes).toHaveLength(0)
  })

  it('refuses a subdivision belonging to a different country', async () => {
    // An Oregon address that says Malaysia is not an address, and it would
    // have been taxed at Oregon's rate of nothing.
    const { env } = fakeD1()
    expect((await placeOrder(env, at({ country: 'MY', state: 'OR', postal: '50450' }))).status).toBe(400)
  })

  it('requires an empty subdivision where the country has none', async () => {
    const { env } = fakeD1()
    expect((await placeOrder(env, at({ country: 'SG', state: '', postal: '238839' }))).status).toBe(200)

    const res = await placeOrder(env, at({ country: 'SG', state: 'CA', postal: '238839' }))
    expect(res.status).toBe(400)
    // And says which fault it was. "bad region" for a country that has no
    // regions points the caller at a field that should not have been sent.
    expect((res.body as { error: string }).error).toMatch(/carry no state/)
  })

  it('holds the postcode to the destination format', async () => {
    const { env } = fakeD1()
    // A US ZIP is not a Malaysian postcode, and the reverse was the bug: the
    // form accepted one shape and this endpoint demanded another.
    expect((await placeOrder(env, at({ country: 'MY', state: 'SGR', postal: '94016-1234' }))).status).toBe(400)
    expect((await placeOrder(env, at({ country: 'GB', state: '', postal: 'SW1A 1AA' }))).status).toBe(200)
  })

  it('treats the apartment line and the phone as optional', async () => {
    const { env, writes } = fakeD1()
    const res = await placeOrder(env, at({ line2: 'Flat 3', phone: '+60 12-345 6789' }))
    expect(res.status).toBe(200)
    expect(orderRow(writes).args).toContain('Flat 3')

    const bare = fakeD1()
    expect((await placeOrder(bare.env, payload())).status).toBe(200)
    expect(orderRow(bare.writes).args).toContain('')
  })


  it('refuses a delivery method the destination has no carrier for', async () => {
    /*
     * Not just "is this one of the three methods". Overnight is a domestic
     * service; accepting it for Kuala Lumpur would take $29.95 for a delivery
     * nobody has agreed to make, and the UI does not even offer it.
     */
    const { env, writes } = fakeD1()
    const res = await placeOrder(
      env,
      payload({
        address: { ...payload().address, country: 'MY', state: 'SGR', postal: '50450' } as never,
        method: 'overnight',
      }),
    )
    expect(res.status).toBe(400)
    expect((res.body as { error: string }).error).toMatch(/not available to Malaysia/)
    expect(writes).toHaveLength(0)
  })

  it('charges the destination its own delivery rate', async () => {
    // One flat table billed $8.95 to send a laptop across town and $8.95 to
    // send it to Kuala Lumpur.
    // Under the $75 domestic free-delivery bar, so both legs are actually
    // charged and the comparison is between two prices rather than two zeros.
    const cheap = products.find((p) => Math.round(p.price * 100) < 7500)!
    const line = { sku: cheap.sku, qty: 1 }
    const home = fakeD1()
    const away = fakeD1()

    const us = await placeOrder(home.env, payload({ lines: [line] }))
    const my = await placeOrder(
      away.env,
      payload({
        address: { ...payload().address, country: 'MY', state: 'SGR', postal: '50450' } as never,
        lines: [line],
      }),
    )

    const cents = Math.round(cheap.price * 100)
    expect((us.body as { total: number }).total).toBe(cents + 895)
    expect((my.body as { total: number }).total).toBe(cents + 2695 + Math.round(cents * 0.08))
  })

  it('refuses a phone number that cannot be one', async () => {
    const { env } = fakeD1()
    expect((await placeOrder(env, at({ phone: 'call me maybe' }))).status).toBe(400)
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
