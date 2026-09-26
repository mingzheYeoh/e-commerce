import { describe, it, expect } from 'vitest'
import { placeOrder, getOrder, maskEmail, type OrderPayload } from './orders'
import { memoryD1 } from '../test/d1-memory'
import { accountOrders } from './auth'

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
    expect(res.body).toEqual({
      id: 'NX-4K2P9',
      total: unitCents,
      totals: { subtotal: unitCents, shipping: 0, tax: 0, total: unitCents },
      payment: { method: 'card', channel: '', ref: expect.stringMatching(/^SIM-CARD-/) },
    })
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

  it("will not sell a suspended merchant's product, published or not, and sells it again once restored", async () => {
    // A basket or a cached catalogue can still hold the id after the
    // storefront stopped showing it; checkout is where suspension has to bite.
    const { db, raw, rows } = seeded()
    raw.prepare(`UPDATE merchants SET status = 'suspended' WHERE id = 'mch_nexus'`).run()
    const refused = await placeOrder({ ORDERS: db }, payload())
    expect(refused).toEqual({ status: 400, body: { error: 'unknown product' } })
    expect(rows('orders')).toHaveLength(0)

    raw.prepare(`UPDATE merchants SET status = 'active' WHERE id = 'mch_nexus'`).run()
    expect((await placeOrder({ ORDERS: db }, payload())).status).toBe(200)
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

  it('answers a repeated order id with the stored order, and stores it once', async () => {
    // A retry after a lost answer. The checkout decides whether the id was its
    // own; the server says what that order was.
    const { db, rows } = seeded()
    expect((await placeOrder({ ORDERS: db }, payload())).status).toBe(200)
    expect(await placeOrder({ ORDERS: db }, payload())).toEqual({
      status: 200,
      body: {
        id: 'NX-4K2P9',
        total: unitCents,
        totals: { subtotal: unitCents, shipping: 0, tax: 0, total: unitCents },
        payment: { method: 'card', channel: '', ref: rows('orders')[0].payment_ref },
        existing: true,
      },
    })
    expect(rows('orders')).toHaveLength(1)
  })

  it('tells a request with a different email only that the id is taken, never what the order was', async () => {
    // Order ids are short enough to guess. The stored totals are a retry's
    // answer, and a retry resends the email it was placed with.
    const { db } = seeded()
    expect((await placeOrder({ ORDERS: db }, payload())).status).toBe(200)
    const guess = await placeOrder({ ORDERS: db }, payload({ address: { ...payload().address, email: 'someone@else.test' } }))
    expect(guess).toEqual({ status: 409, body: { error: 'That order id is already taken.', code: 'duplicate' } })
    // Case and surrounding spaces are not a different person.
    const shouted = await placeOrder(
      { ORDERS: db },
      payload({ address: { ...payload().address, email: `  ${payload().address.email.toUpperCase()} ` } }),
    )
    expect(shouted.status).toBe(200)
  })

  it('reports two racing inserts of one id as a duplicate, not a server fault', async () => {
    // Both passed the lookup; the table's own primary key decides.
    const { db } = seeded()
    const racing = {
      prepare: db.prepare.bind(db),
      batch: (async (stmts: D1PreparedStatement[]) => {
        await placeOrder({ ORDERS: db }, payload())
        return db.batch(stmts)
      }) as D1Database['batch'],
    } as unknown as D1Database
    expect(await placeOrder({ ORDERS: racing }, payload())).toEqual({
      status: 409,
      body: { error: 'order already exists', code: 'duplicate' },
    })
  })

  it('rejects a body that is not an object at all', async () => {
    const { db } = seeded()
    for (const body of [null, 'order', 42, undefined]) {
      expect((await placeOrder({ ORDERS: db }, body)).status).toBe(400)
    }
  })
})

describe('placeOrder and stock', () => {
  const stock = (raw: ReturnType<typeof seeded>['raw'], id: string) =>
    (raw.prepare(`SELECT stock_count FROM products WHERE id = ?`).get(id) as { stock_count: number }).stock_count

  it('takes the units out of stock and opens a pending part per merchant, with the order', async () => {
    const { db, raw, rows } = seeded()
    const res = await placeOrder(
      { ORDERS: db },
      payload({
        lines: [
          // Two finishes of one product draw on one stock count: 2 + 3 of 9.
          { productId: FLAGSHIP.id, qty: 2, finish: FINISHES[0] },
          { productId: FLAGSHIP.id, qty: 3, finish: FINISHES[1] },
          { productId: CHEAP.id, qty: 1 },
        ],
      }),
    )
    expect(res.status).toBe(200)
    expect([stock(raw, FLAGSHIP.id), stock(raw, CHEAP.id)]).toEqual([4, 8])
    expect(rows('order_fulfilments')).toEqual([expect.objectContaining({ order_id: 'NX-4K2P9', merchant_id: 'mch_nexus', status: 'pending' })])
  })

  it('refuses the whole order, naming the product, when one line wants more than is left', async () => {
    const { db, raw, rows } = seeded()
    raw.prepare(`UPDATE products SET stock_count = 1 WHERE id = ?`).run(CHEAP.id)
    const res = await placeOrder(
      { ORDERS: db },
      payload({ lines: [{ productId: FLAGSHIP.id, qty: 1 }, { productId: CHEAP.id, qty: 2 }] }),
    )
    expect(res).toEqual({ status: 409, body: { error: 'Only 1 of "Cheap Thing" left in stock. Lower the quantity to continue.' } })

    raw.prepare(`UPDATE products SET stock_count = 0 WHERE id = ?`).run(CHEAP.id)
    const soldOut = await placeOrder({ ORDERS: db }, payload({ lines: [{ productId: CHEAP.id, qty: 1 }] }))
    expect(soldOut).toEqual({ status: 409, body: { error: '"Cheap Thing" is sold out. Remove it from your cart to continue.' } })

    // No partial write: not the order, not its lines, not the flagship's stock.
    expect(rows('orders')).toEqual([])
    expect(rows('order_lines')).toEqual([])
    expect(rows('order_fulfilments')).toEqual([])
    expect(stock(raw, FLAGSHIP.id)).toBe(9)
  })

  it('refuses, and writes nothing, when another checkout takes the last units between the check and the write', async () => {
    // The pre-check reads 9 in stock. Then a racing checkout empties the
    // shelf, and the stock CHECK aborts this order's batch as a whole.
    const { db, raw, rows } = seeded()
    const racing = {
      prepare: db.prepare.bind(db),
      batch: (async (stmts: D1PreparedStatement[]) => {
        raw.prepare(`UPDATE products SET stock_count = 0 WHERE id = ?`).run(FLAGSHIP.id)
        return db.batch(stmts)
      }) as D1Database['batch'],
    } as unknown as D1Database
    const res = await placeOrder({ ORDERS: racing }, payload({ lines: [{ productId: FLAGSHIP.id, qty: 1 }, { productId: CHEAP.id, qty: 1 }] }))
    expect(res).toEqual({ status: 409, body: { error: '"Flagship Thing" is sold out. Remove it from your cart to continue.' } })
    expect(rows('orders')).toEqual([])
    expect(rows('order_lines')).toEqual([])
    expect(rows('order_fulfilments')).toEqual([])
    expect(stock(raw, CHEAP.id)).toBe(9)
  })

  it('leaves stock alone for a declined attempt, which opens no part either', async () => {
    const { db, raw, rows } = seeded()
    raw.prepare(`UPDATE products SET stock_count = 0 WHERE id = ?`).run(FLAGSHIP.id)
    // Recorded for the audit trail even though nothing is in stock: nothing was sold.
    expect((await placeOrder({ ORDERS: db }, payload({ paymentCode: 'card_declined' }))).status).toBe(200)
    expect(stock(raw, FLAGSHIP.id)).toBe(0)
    expect(rows('order_fulfilments')).toEqual([])
  })

  it('answers a replay of an order that took the last unit as that order, not as sold out', async () => {
    // Stock 1: the first POST lands and takes it, its answer is lost, the
    // checkout retries. Judged afresh, the replay would be refused as sold out
    // by its own unit, and the shopper sent to pay again.
    const { db, raw, rows } = seeded()
    raw.prepare(`UPDATE products SET stock_count = 1 WHERE id = ?`).run(FLAGSHIP.id)
    expect((await placeOrder({ ORDERS: db }, payload())).status).toBe(200)
    const replay = await placeOrder({ ORDERS: db }, payload())
    expect(replay).toMatchObject({ status: 200, body: { id: 'NX-4K2P9', total: unitCents, existing: true } })
    expect(stock(raw, FLAGSHIP.id)).toBe(0)
    // Even once the product is off sale, the stored order is still the answer.
    raw.prepare(`UPDATE products SET status = 'archived'`).run()
    expect((await placeOrder({ ORDERS: db }, payload())).status).toBe(200)
    expect(rows('orders')).toHaveLength(1)
  })

  it('marks the part as having taken stock, so a cancel may put it back', async () => {
    const { db, rows } = seeded()
    await placeOrder({ ORDERS: db }, payload())
    expect(rows('order_fulfilments')[0]).toMatchObject({ stock_taken: 1 })
  })
})

describe('placeOrder and commission', () => {
  it("freezes the merchant's rate onto each line, so a later change prices only later sales", async () => {
    const { db, raw } = seeded()
    await placeOrder({ ORDERS: db }, payload())
    raw.prepare(`UPDATE merchants SET commission_bps = 1250`).run()
    await placeOrder({ ORDERS: db }, payload({ id: 'NX-5M3RT' }))
    expect(raw.prepare(`SELECT order_id, commission_bps FROM order_lines ORDER BY order_id`).all()).toEqual([
      { order_id: 'NX-4K2P9', commission_bps: 800 },
      { order_id: 'NX-5M3RT', commission_bps: 1250 },
    ])
  })
})

describe('placeOrder and payment', () => {
  const REF = /^SIM-FPX-[A-HJ-NP-Z2-9]{6}$/

  it('records an FPX payment by bank name, with a reference the server minted', async () => {
    const { db, rows } = seeded()
    const res = await placeOrder({ ORDERS: db }, { ...payload(), paymentMethod: 'fpx', paymentChannel: 'Maybank2u' })
    expect(res.status).toBe(200)
    const body = res.body as { payment: { method: string; channel: string; ref: string } }
    expect(body.payment).toEqual({ method: 'fpx', channel: 'Maybank2u', ref: expect.stringMatching(REF) })
    expect(rows('orders')[0]).toMatchObject({ payment_method: 'fpx', payment_channel: 'Maybank2u', payment_ref: body.payment.ref })
  })

  it('takes no reference from the caller', async () => {
    const { db, rows } = seeded()
    await placeOrder({ ORDERS: db }, { ...payload(), paymentMethod: 'ewallet', paymentChannel: 'GrabPay', paymentRef: 'SIM-EWALLET-AAAAAA' })
    expect(rows('orders')[0].payment_ref).toMatch(/^SIM-EWALLET-[A-HJ-NP-Z2-9]{6}$/)
    expect(rows('orders')[0].payment_ref).not.toBe('SIM-EWALLET-AAAAAA')
  })

  it('refuses a channel that is not on the list for its method, and stores nothing', async () => {
    const { db, rows } = seeded()
    const cases = [
      { paymentMethod: 'fpx', paymentChannel: 'Some Other Bank' },
      { paymentMethod: 'fpx', paymentChannel: 'GrabPay' },
      { paymentMethod: 'card', paymentChannel: 'Discover' },
      { paymentMethod: 'ewallet', paymentChannel: '' },
      { paymentMethod: 'crypto', paymentChannel: 'Visa' },
    ]
    for (const c of cases) {
      expect((await placeOrder({ ORDERS: db }, { ...payload(), ...c })).status, JSON.stringify(c)).toBe(400)
    }
    expect(rows('orders')).toEqual([])
  })

  it('records a card by its brand alone', async () => {
    const { db, rows } = seeded()
    await placeOrder({ ORDERS: db }, { ...payload(), paymentMethod: 'card', paymentChannel: 'Visa' })
    expect(rows('orders')[0]).toMatchObject({ payment_method: 'card', payment_channel: 'Visa' })
    expect(rows('orders')[0].payment_ref).toMatch(/^SIM-CARD-/)
  })

  it('files a request from a storefront that predates payment methods as a card', async () => {
    // Cached pages post neither field until the new storefront deploys.
    const { db, rows } = seeded()
    expect((await placeOrder({ ORDERS: db }, payload())).status).toBe(200)
    expect(rows('orders')[0]).toMatchObject({ payment_method: 'card', payment_channel: '' })
  })

  it('refuses a declined FPX or e-wallet attempt: only an approval is ever posted', async () => {
    const { db, rows } = seeded()
    const res = await placeOrder({ ORDERS: db }, { ...payload({ paymentCode: 'card_declined' }), paymentMethod: 'fpx', paymentChannel: 'BSN' })
    expect(res.status).toBe(400)
    expect(rows('orders')).toEqual([])
  })

  it('answers a retry with the reference first stored', async () => {
    const { db } = seeded()
    const first = await placeOrder({ ORDERS: db }, { ...payload(), paymentMethod: 'fpx', paymentChannel: 'UOB' })
    const again = await placeOrder({ ORDERS: db }, { ...payload(), paymentMethod: 'fpx', paymentChannel: 'UOB' })
    expect(again.body).toMatchObject({ existing: true, payment: (first.body as { payment: unknown }).payment })
  })
})

describe('getOrder details', () => {
  it("gives every line its product, seller and, for the account that placed it, that seller's status", async () => {
    const { db, raw } = seeded()
    await placeOrder(
      { ORDERS: db },
      { ...payload({ lines: [{ productId: FLAGSHIP.id, qty: 2, finish: 'Silver' }] }), paymentMethod: 'fpx', paymentChannel: 'Maybank2u' },
      'usr_owner',
    )
    raw.prepare(`UPDATE order_fulfilments SET status = 'delivered', carrier = 'UPS', tracking = '1Z', shipped_at = datetime('now'), delivered_at = datetime('now')`).run()
    const owner = await getOrder({ ORDERS: db }, 'NX-4K2P9', 'usr_owner')
    expect(owner!.lines).toEqual([
      {
        productId: FLAGSHIP.id,
        sku: FLAGSHIP.sku,
        title: FLAGSHIP.title,
        qty: 2,
        unitPriceCents: FLAGSHIP.price,
        finish: 'Silver',
        seller: 'Nexus',
        status: 'delivered',
      },
    ])
    expect(owner!.payment).toEqual({ method: 'fpx', channel: 'Maybank2u', ref: expect.stringMatching(/^SIM-FPX-/) })

    for (const viewer of [null, 'usr_stranger']) {
      const seen = (await getOrder({ ORDERS: db }, 'NX-4K2P9', viewer))!
      expect(seen.lines[0]).toMatchObject({ productId: FLAGSHIP.id, seller: 'Nexus', status: null })
      expect(seen.payment).toEqual({ method: 'fpx', channel: 'Maybank2u', ref: null })
      expect(seen.address.line1).toBe('')
    }
  })
})

describe('getOrder', () => {
  /** A paid order filed to usr_owner, shipped by its one seller, with one unit refunded. */
  async function shippedOrder() {
    const mem = seeded()
    await placeOrder({ ORDERS: mem.db }, payload({ lines: [{ productId: FLAGSHIP.id, qty: 2 }] }), 'usr_owner')
    mem.raw
      .prepare(
        `UPDATE order_fulfilments SET status = 'shipped', carrier = 'UPS', tracking = '1Z999', shipped_at = datetime('now')`,
      )
      .run()
    mem.raw
      .prepare(
        `INSERT INTO refunds (id, order_id, merchant_id, product_id, qty, amount_minor, reason, actor_id, actor_scope)
         VALUES ('rfd_1', 'NX-4K2P9', 'mch_nexus', ?, 1, ?, 'Damaged', 'stf_1', 'merchant')`,
      )
      .run(FLAGSHIP.id, FLAGSHIP.price)
    return mem
  }

  it('gives the account that placed the order its delivery and refunds', async () => {
    const { db } = await shippedOrder()
    const order = await getOrder({ ORDERS: db }, 'NX-4K2P9', 'usr_owner')
    expect(order!.parts).toEqual([
      {
        seller: 'Nexus',
        status: 'shipped',
        carrier: 'UPS',
        tracking: '1Z999',
        shippedAt: expect.any(String),
        deliveredAt: null,
        items: [{ sku: FLAGSHIP.sku, title: FLAGSHIP.title, qty: 2, finish: undefined }],
        refunded: [{ currency: 'USD', minor: FLAGSHIP.price }],
      },
    ])
  })

  it('shows anyone else holding the id no more than it always did', async () => {
    // Signed out, or signed in as somebody else: the tracking number and the
    // refunds are not theirs to read.
    const { db } = await shippedOrder()
    for (const viewer of [null, 'usr_stranger']) {
      const order = await getOrder({ ORDERS: db }, 'NX-4K2P9', viewer)
      expect(order, String(viewer)).not.toHaveProperty('parts')
      expect(JSON.stringify(order)).not.toMatch(/1Z999|UPS|Damaged/)
    }
  })

  it("lists delivery and refunds in the account's own order history, and nobody else's", async () => {
    const { db } = await shippedOrder()
    const mine = await accountOrders({ ORDERS: db } as never, { id: 'usr_owner', email: 'a@x.co', name: 'A' })
    expect(mine).toEqual([
      expect.objectContaining({
        id: 'NX-4K2P9',
        fulfilment: [{ status: 'shipped', carrier: 'UPS', tracking: '1Z999' }],
        refunded: [{ currency: 'USD', minor: FLAGSHIP.price }],
      }),
    ])
    expect(await accountOrders({ ORDERS: db } as never, { id: 'usr_stranger', email: 'b@x.co', name: 'B' })).toEqual([])
  })

  it('never adds them to a guest order, which no account owns', async () => {
    const { db, raw } = seeded()
    await placeOrder({ ORDERS: db }, payload())
    raw.prepare(`UPDATE order_fulfilments SET status = 'shipped', carrier = 'UPS', tracking = '1Z', shipped_at = datetime('now')`).run()
    expect(await getOrder({ ORDERS: db }, 'NX-4K2P9', null)).not.toHaveProperty('parts')
  })

  it('shows where an order is going only to the account that placed it', async () => {
    const { db } = seeded()
    await placeOrder({ ORDERS: db }, payload(), 'usr_owner')
    const owner = await getOrder({ ORDERS: db }, 'NX-4K2P9', 'usr_owner')
    expect(owner?.address).toMatchObject({ name: 'Ada Lovelace', line1: '12 Analytical Way' })
    for (const viewer of [null, 'usr_stranger']) {
      const seen = (await getOrder({ ORDERS: db }, 'NX-4K2P9', viewer))!.address
      expect(seen.name).toBe('Ada')
      expect([seen.line1, seen.line2, seen.postal, seen.phone]).toEqual(['', '', '', ''])
      expect(seen.city).toBe(owner!.address.city)
    }
  })
})

describe('maskEmail', () => {
  it('leaves enough to recognise and not enough to reconstruct', () => {
    expect(maskEmail('ada@example.com')).toBe('a•••@example.com')
    expect(maskEmail('nonsense')).toBe('•••')
  })
})
