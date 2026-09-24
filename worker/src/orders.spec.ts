import { describe, it, expect } from 'vitest'
import { placeOrder, maskEmail, type OrderPayload } from './orders'
import { memoryD1 } from '../test/d1-memory'

/**
 * A real SQLite database, because the server now reads one.
 *
 * This suite used to run against a notebook that recorded SQL strings and
 * executed nothing. That was adequate only while placeOrder never read
 * anything back — and it hid the very bug this file exists to catch: the
 * insert had stopped naming two NOT NULL columns and every test stayed green.
 *
 * The products are seeded here rather than by running the seed migration. A
 * checkout test wants two products it can name and reason about, not the
 * catalogue's forty-five.
 */
const FINISHES = ['Carbon', 'Silver'] as const

/** Clears the domestic free-delivery bar, so shipping is free and the total is the price. */
const FLAGSHIP = { id: 'prd_flagship', sku: 'NX-FLAG-1', title: 'Flagship Thing', price: 119900 }
/** Under the $75 bar, so both delivery legs are actually charged. */
const CHEAP = { id: 'prd_cheap', sku: 'NX-CHEAP-1', title: 'Cheap Thing', price: 4900 }

function seeded() {
  const mem = memoryD1()
  mem.raw
    .prepare(
      `INSERT INTO merchants (id,slug,name,settlement_currency,status)
       VALUES ('mch_nexus','nexus','Nexus','USD','active')`,
    )
    .run()
  for (const p of [FLAGSHIP, CHEAP]) {
    mem.raw
      .prepare(
        `INSERT INTO products (id,merchant_id,sku,title,brand,category,
                               price_minor,currency,status,stock_count,colorways)
         VALUES (?,'mch_nexus',?,?,'apple','phones',?,'USD','published',9,?)`,
      )
      .run(p.id, p.sku, p.title, p.price, JSON.stringify(FINISHES.map((name) => ({ name, hex: '#000' }))))
  }
  return mem
}

const unitCents = FLAGSHIP.price

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
  lines: [{ productId: FLAGSHIP.id, qty: 1 }],
  paymentCode: 'succeeded',
  ...over,
})

describe('placeOrder', () => {
  it('stores an order and returns the total it computed itself', async () => {
    const { db, rows } = seeded()
    const res = await placeOrder({ ORDERS: db }, payload())

    expect(res.status).toBe(200)
    // Oregon levies no sales tax, and this product clears the free-shipping bar.
    expect(res.body).toEqual({ id: 'NX-4K2P9', total: unitCents })
    expect(rows('orders')).toHaveLength(1)
    expect(rows('order_lines')).toHaveLength(1)
  })

  it('writes the product and the merchant onto every line', async () => {
    // Both are NOT NULL. An insert that omits them fails in D1 and takes the
    // whole checkout with it, which is exactly what a write-recording stand-in
    // could not notice.
    const { db, rows } = seeded()
    expect((await placeOrder({ ORDERS: db }, payload())).status).toBe(200)
    expect(rows('order_lines')[0]).toMatchObject({
      product_id: FLAGSHIP.id,
      merchant_id: 'mch_nexus',
      sku: FLAGSHIP.sku,
      title: FLAGSHIP.title,
    })
  })

  it('ignores prices in the request and uses the catalogue', async () => {
    // The whole reason the payload carries no prices. If a caller could name
    // its own, the totals would be whatever it felt like paying.
    const { db, rows } = seeded()
    const res = await placeOrder({ ORDERS: db }, {
      ...payload(),
      lines: [{ productId: FLAGSHIP.id, qty: 1, unitPriceCents: 1 }],
      totals: { subtotal: 1, shipping: 0, tax: 0, total: 1 },
    } as unknown as OrderPayload)

    expect(res.status).toBe(200)
    expect((res.body as { total: number }).total).toBe(unitCents)
    expect(rows('orders')[0]).toMatchObject({ total_cents: unitCents })
    expect(rows('order_lines')[0]).toMatchObject({ unit_price_cents: unitCents })
  })

  it('prices from the database on every checkout, not from a cached copy', async () => {
    /*
     * A price read once per isolate is stale until the next deploy, and price
     * is the last field that may be stale. So the second order here is placed
     * against the same module after the row changed underneath it.
     *
     * The new price is deliberately under the $75 domestic free-delivery bar
     * (ZONES.domestic.standard.freeAbove = 7500, src/lib/shipping.ts) while the
     * seeded one is far above it, so the two orders differ in both legs of the
     * total. A cached price cannot reach the second number by accident — it
     * would answer 119900 with delivery free. Do not "fix" the 895 away.
     */
    const RESTICKERED = 6100
    const { db, raw } = seeded()
    const before = await placeOrder({ ORDERS: db }, payload())
    expect((before.body as { total: number }).total).toBe(unitCents)

    raw.prepare(`UPDATE products SET price_minor = ? WHERE id = ?`).run(RESTICKERED, FLAGSHIP.id)

    const after = await placeOrder({ ORDERS: db }, payload({ id: 'NX-5M3RT' }))
    expect((after.body as { total: number }).total).toBe(RESTICKERED + 895)
  })

  it('charges tax and shipping the destination actually implies', async () => {
    const { db } = seeded()
    const res = await placeOrder(
      { ORDERS: db },
      payload({
        address: { ...payload().address, state: 'CA' },
        method: 'overnight',
      }),
    )
    const total = (res.body as { total: number }).total
    // Overnight is never free, and California is never tax free.
    expect(total).toBe(unitCents + 2995 + Math.round(unitCents * 0.0725))
  })

  it('stores a finish the product is actually sold in', async () => {
    const { db, rows } = seeded()
    const finish = FINISHES[0]
    const res = await placeOrder({ ORDERS: db }, payload({ lines: [{ productId: FLAGSHIP.id, qty: 1, finish }] }))
    expect(res.status).toBe(200)
    expect(rows('order_lines')[0]).toMatchObject({ variant: finish })
  })

  it('refuses a finish the product is not sold in', async () => {
    /*
     * Refused rather than quietly dropped. A finish the catalogue does not
     * recognise means the basket and the catalogue disagree, and forgetting it
     * silently is how someone receives the wrong colour.
     */
    const { db, rows } = seeded()
    const res = await placeOrder(
      { ORDERS: db },
      payload({ lines: [{ productId: FLAGSHIP.id, qty: 1, finish: 'Chartreuse' }] }),
    )
    expect(res.status).toBe(400)
    expect(rows('orders')).toHaveLength(0)
  })

  it('treats two finishes of one product as two lines', async () => {
    // Keyed on the product alone, ordering a black one and a silver one loses
    // the second — which is why the primary key carries the variant.
    const { db, rows } = seeded()
    const res = await placeOrder(
      { ORDERS: db },
      payload({
        lines: [
          { productId: FLAGSHIP.id, qty: 1, finish: FINISHES[0] },
          { productId: FLAGSHIP.id, qty: 1, finish: FINISHES[1] },
        ],
      }),
    )
    expect(res.status).toBe(200)
    expect(rows('order_lines')).toHaveLength(2)
  })

  it('still refuses the same product in the same finish twice', async () => {
    const { db } = seeded()
    const finish = FINISHES[0]
    const res = await placeOrder(
      { ORDERS: db },
      payload({
        lines: [
          { productId: FLAGSHIP.id, qty: 1, finish },
          { productId: FLAGSHIP.id, qty: 2, finish },
        ],
      }),
    )
    expect(res.status).toBe(400)
  })

  it('stores an empty string when no finish was chosen', async () => {
    // Not NULL: the column is part of the primary key, and SQLite treats NULLs
    // there as distinct, so the same line could be inserted twice.
    const { db, rows } = seeded()
    await placeOrder({ ORDERS: db }, payload())
    expect(rows('order_lines')[0]).toMatchObject({ variant: '' })
  })

  it('refuses a product id that is not in the catalogue', async () => {
    const { db, rows } = seeded()
    const res = await placeOrder({ ORDERS: db }, payload({ lines: [{ productId: 'prd_free_money', qty: 1 }] }))
    expect(res.status).toBe(400)
    expect(rows('orders')).toHaveLength(0)
  })

  it('refuses quantities that are negative, fractional or absurd', async () => {
    for (const qty of [0, -3, 1.5, 100, Number.NaN]) {
      const { db } = seeded()
      const res = await placeOrder({ ORDERS: db }, payload({ lines: [{ productId: FLAGSHIP.id, qty }] }))
      expect(res.status, `qty ${qty} should be refused`).toBe(400)
    }
  })

  it('refuses an id that is not one the client could have drawn', async () => {
    for (const id of ['NX-AAAA', 'nx-4k2p9', "NX-4K2P9'; DROP TABLE orders--", 'NX-I0O1A']) {
      const { db } = seeded()
      expect((await placeOrder({ ORDERS: db }, payload({ id }))).status, id).toBe(400)
    }
  })

  it('refuses a payment code outside the four the schema allows', async () => {
    // A CHECK constraint would catch this, but as a 503 from the database
    // rather than a 400 the caller can act on.
    const { db } = seeded()
    expect((await placeOrder({ ORDERS: db }, payload({ paymentCode: 'definitely_paid' }))).status).toBe(400)
  })

  it('refuses an incomplete address and an unparseable email', async () => {
    const { db } = seeded()
    expect(
      (await placeOrder({ ORDERS: db }, payload({ address: { ...payload().address, city: '' } }))).status,
    ).toBe(400)
    expect(
      (await placeOrder({ ORDERS: db }, payload({ address: { ...payload().address, email: 'ada' } }))).status,
    ).toBe(400)
  })

  it('files the order to the signed-in account, and to nobody otherwise', async () => {
    /*
     * The account link comes from the session, which the caller reads from a
     * cookie — never from the payload. A request that could name its own owner
     * could file its order into someone else's history.
     */
    const signedIn = seeded()
    await placeOrder({ ORDERS: signedIn.db }, payload(), 'usr_abc')
    expect(signedIn.rows('orders')[0]).toMatchObject({ user_id: 'usr_abc' })

    const guest = seeded()
    await placeOrder({ ORDERS: guest.db }, payload())
    expect(guest.rows('orders')[0]).toMatchObject({ user_id: null })
  })
})

describe('placeOrder prices from the catalogue', () => {
  it('charges each merchant their own price for the same sku', async () => {
    const { db, raw } = memoryD1()
    for (const [mid, slug] of [
      ['mch_a', 'a'],
      ['mch_b', 'b'],
    ]) {
      raw
        .prepare(
          `INSERT INTO merchants (id,slug,name,settlement_currency,status)
           VALUES (?,?,?, 'USD','active')`,
        )
        .run(mid, slug, slug)
    }
    // The same SKU, two merchants, two prices. UNIQUE (merchant_id, sku) permits
    // this on purpose, and it is why a sku-keyed price lookup is a guess.
    raw
      .prepare(
        `INSERT INTO products (id,merchant_id,sku,title,brand,category,
                               price_minor,currency,status,stock_count)
         VALUES ('cheap','mch_a','IP18P-256','A','apple','phones',
                 10000,'USD','published',5)`,
      )
      .run()
    raw
      .prepare(
        `INSERT INTO products (id,merchant_id,sku,title,brand,category,
                               price_minor,currency,status,stock_count)
         VALUES ('dear','mch_b','IP18P-256','B','apple','phones',
                 99900,'USD','published',5)`,
      )
      .run()

    const result = await placeOrder({ ORDERS: db }, payload({ lines: [{ productId: 'dear', qty: 1 }] }))

    expect(result.status).toBe(200)
    const line = raw.prepare(`SELECT product_id, merchant_id, unit_price_cents FROM order_lines`).get()
    expect(line).toEqual({ product_id: 'dear', merchant_id: 'mch_b', unit_price_cents: 99900 })
  })

  it('refuses a product id that is not published', async () => {
    // Draft and archived rows are in the same table as the live ones. A lookup
    // by id alone would sell something nobody has put on sale.
    const { db, raw } = memoryD1()
    raw
      .prepare(
        `INSERT INTO merchants (id,slug,name,settlement_currency,status)
         VALUES ('mch_a','a','A','USD','active')`,
      )
      .run()
    raw
      .prepare(
        `INSERT INTO products (id,merchant_id,sku,title,brand,category,
                               price_minor,currency,status,stock_count)
         VALUES ('draft1','mch_a','S','T','apple','phones',
                 100,'USD','draft',5)`,
      )
      .run()

    const result = await placeOrder({ ORDERS: db }, payload({ lines: [{ productId: 'draft1', qty: 1 }] }))
    expect(result.status).toBe(400)
    expect((result.body as { error: string }).error).toBe('unknown product')
  })
})

describe('placeOrder addresses', () => {
  const at = (over: Record<string, unknown>) =>
    payload({ address: { ...payload().address, ...over } as never })

  it('accepts an address from any country the store ships to', async () => {
    const { db, rows } = seeded()
    const res = await placeOrder({ ORDERS: db }, at({ country: 'MY', state: 'SGR', postal: '50450' }))
    expect(res.status).toBe(200)
    expect(rows('orders')[0]).toMatchObject({ ship_country: 'MY' })
  })

  it('charges the destination its own tax, not an American one', async () => {
    // The whole reason country reaches totalCents. Before this, a Malaysian
    // order was charged 6% US default sales tax under a "Tax" label.
    const { db } = seeded()
    const res = await placeOrder({ ORDERS: db }, at({ country: 'MY', state: 'SGR', postal: '50450' }))
    expect((res.body as { total: number }).total).toBe(unitCents + Math.round(unitCents * 0.08))
  })

  it('refuses a country the store does not ship to', async () => {
    const { db, rows } = seeded()
    const res = await placeOrder({ ORDERS: db }, at({ country: 'ZZ' }))
    expect(res.status).toBe(400)
    expect(rows('orders')).toHaveLength(0)
  })

  it('refuses a subdivision belonging to a different country', async () => {
    // An Oregon address that says Malaysia is not an address, and it would
    // have been taxed at Oregon's rate of nothing.
    const { db } = seeded()
    expect(
      (await placeOrder({ ORDERS: db }, at({ country: 'MY', state: 'OR', postal: '50450' }))).status,
    ).toBe(400)
  })

  it('requires an empty subdivision where the country has none', async () => {
    const { db } = seeded()
    expect(
      (await placeOrder({ ORDERS: db }, at({ country: 'SG', state: '', postal: '238839' }))).status,
    ).toBe(200)

    // A second order needs an id of its own now that the orders really land in
    // a table with a primary key.
    const res = await placeOrder(
      { ORDERS: db },
      { ...at({ country: 'SG', state: 'CA', postal: '238839' }), id: 'NX-5M3RT' },
    )
    expect(res.status).toBe(400)
    // And says which fault it was. "bad region" for a country that has no
    // regions points the caller at a field that should not have been sent.
    expect((res.body as { error: string }).error).toMatch(/carry no state/)
  })

  it('holds the postcode to the destination format', async () => {
    const { db } = seeded()
    // A US ZIP is not a Malaysian postcode, and the reverse was the bug: the
    // form accepted one shape and this endpoint demanded another.
    expect(
      (await placeOrder({ ORDERS: db }, at({ country: 'MY', state: 'SGR', postal: '94016-1234' }))).status,
    ).toBe(400)
    expect(
      (await placeOrder({ ORDERS: db }, at({ country: 'GB', state: '', postal: 'SW1A 1AA' }))).status,
    ).toBe(200)
  })

  it('treats the apartment line and the phone as optional', async () => {
    const { db, rows } = seeded()
    const res = await placeOrder({ ORDERS: db }, at({ line2: 'Flat 3', phone: '+60 12-345 6789' }))
    expect(res.status).toBe(200)
    expect(rows('orders')[0]).toMatchObject({ ship_line2: 'Flat 3' })

    const bare = seeded()
    expect((await placeOrder({ ORDERS: bare.db }, payload())).status).toBe(200)
    expect(bare.rows('orders')[0]).toMatchObject({ ship_line2: '', ship_phone: '' })
  })

  it('refuses a delivery method the destination has no carrier for', async () => {
    /*
     * Not just "is this one of the three methods". Overnight is a domestic
     * service; accepting it for Kuala Lumpur would take $29.95 for a delivery
     * nobody has agreed to make, and the UI does not even offer it.
     */
    const { db, rows } = seeded()
    const res = await placeOrder(
      { ORDERS: db },
      payload({
        address: { ...payload().address, country: 'MY', state: 'SGR', postal: '50450' } as never,
        method: 'overnight',
      }),
    )
    expect(res.status).toBe(400)
    expect((res.body as { error: string }).error).toMatch(/not available to Malaysia/)
    expect(rows('orders')).toHaveLength(0)
  })

  it('charges the destination its own delivery rate', async () => {
    // One flat table billed $8.95 to send a laptop across town and $8.95 to
    // send it to Kuala Lumpur.
    // CHEAP is under the $75 domestic free-delivery bar, so both legs are
    // actually charged and the comparison is between two prices rather than
    // two zeros.
    const line = { productId: CHEAP.id, qty: 1 }
    const home = seeded()
    const away = seeded()

    const us = await placeOrder({ ORDERS: home.db }, payload({ lines: [line] }))
    const my = await placeOrder(
      { ORDERS: away.db },
      payload({
        address: { ...payload().address, country: 'MY', state: 'SGR', postal: '50450' } as never,
        lines: [line],
      }),
    )

    const cents = CHEAP.price
    expect((us.body as { total: number }).total).toBe(cents + 895)
    expect((my.body as { total: number }).total).toBe(cents + 2695 + Math.round(cents * 0.08))
  })

  it('refuses a phone number that cannot be one', async () => {
    const { db } = seeded()
    expect((await placeOrder({ ORDERS: db }, at({ phone: 'call me maybe' }))).status).toBe(400)
  })

  it('refuses the same product twice rather than violating the primary key', async () => {
    const { db } = seeded()
    const res = await placeOrder(
      { ORDERS: db },
      payload({
        lines: [
          { productId: FLAGSHIP.id, qty: 1 },
          { productId: FLAGSHIP.id, qty: 2 },
        ],
      }),
    )
    expect(res.status).toBe(400)
  })

  it('reports a repeated order id as a conflict, not a server fault', async () => {
    // Placed twice for real, against the table's own primary key, rather than
    // against a stand-in rigged to throw the message this branch looks for.
    const { db, rows } = seeded()
    expect((await placeOrder({ ORDERS: db }, payload())).status).toBe(200)
    expect((await placeOrder({ ORDERS: db }, payload())).status).toBe(409)
    expect(rows('orders')).toHaveLength(1)
  })

  it('rejects a body that is not an object at all', async () => {
    const { db } = seeded()
    for (const body of [null, 'order', 42, undefined]) {
      expect((await placeOrder({ ORDERS: db }, body)).status).toBe(400)
    }
  })
})

describe('maskEmail', () => {
  it('leaves enough to recognise and not enough to reconstruct', () => {
    expect(maskEmail('ada@example.com')).toBe('a•••@example.com')
    expect(maskEmail('nonsense')).toBe('•••')
  })
})
