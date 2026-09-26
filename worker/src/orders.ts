/**
 * Order persistence in D1.
 *
 * This is the purchase: the checkout waits for it, and writes a receipt and
 * empties the cart only once it answers 200. It is what takes units out of
 * stock, so a refusal here (409, sold out) has to reach the shopper rather than
 * be papered over by a receipt already written.
 *
 * Prices and totals are NOT taken from the request. Each line is priced from
 * the catalogue row it names and the arithmetic is the storefront's own module,
 * so the server reaches its own number and stores that. A request that posts a
 * $1 MacBook gets an order for the real price, not an argument.
 */
import { totalCents, type ShipMethod } from '../../src/lib/money'
import { methodAvailable } from '../../src/lib/shipping'
import {
  findCountry,
  validSubdivision,
  validPostal,
  validPhone,
} from '../../src/lib/regions'
import { CHANNELS, type PayMethod } from '../../src/lib/payment'

export interface OrdersEnv {
  ORDERS: D1Database
}

interface ProductRow {
  id: string
  merchant_id: string
  sku: string
  title: string
  price_minor: number
  colorways: string
  stock_count: number
  /** The merchant's rate now, frozen onto the line it prices. */
  commission_bps: number
}

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
    // A suspended merchant's product is not for sale even if a basket, or a
    // cached copy of the catalogue, still holds it.
    `SELECT p.id, p.merchant_id, p.sku, p.title, p.price_minor, p.colorways, p.stock_count, m.commission_bps
       FROM products p JOIN merchants m ON m.id = p.merchant_id
      WHERE p.status = 'published' AND m.status = 'active' AND p.id IN (${marks})`,
  )
    .bind(...ids)
    .all<ProductRow>()
  return new Map((results ?? []).map((r) => [r.id, r]))
}

/**
 * The first product the order wants more of than is in stock, as a refusal
 * naming it, or null. Units are summed per product, because two finishes of
 * one product are two lines drawing on one stock count.
 */
function shortOf(catalogue: Map<string, ProductRow>, lines: { productId: string; qty: number }[]): string | null {
  const wanted = new Map<string, number>()
  for (const l of lines) wanted.set(l.productId, (wanted.get(l.productId) ?? 0) + l.qty)
  for (const [productId, qty] of wanted) {
    const p = catalogue.get(productId)
    if (!p) return 'Some items are no longer available.'
    if (qty > p.stock_count) {
      return p.stock_count > 0
        ? `Only ${p.stock_count} of "${p.title}" left in stock. Lower the quantity to continue.`
        : `"${p.title}" is sold out. Remove it from your cart to continue.`
    }
  }
  return null
}

/** The finishes a product is actually sold in. Malformed JSON offers none. */
function finishes(row: ProductRow): Set<string> {
  try {
    const parsed = JSON.parse(row.colorways) as { name?: string }[]
    return new Set(parsed.map((c) => c?.name).filter((n): n is string => typeof n === 'string'))
  } catch {
    return new Set()
  }
}

const PAYMENT_CODES = ['succeeded', 'card_declined', 'insufficient_funds', 'expired_card'] as const
type PaymentCode = (typeof PAYMENT_CODES)[number]

/** How an order was paid, as stored: never a card number, only its brand. */
export interface Payment {
  method: PayMethod
  channel: string
  /** Minted here. Null when the reader is not the account that placed the order. */
  ref: string | null
}

const REF_PREFIX: Record<PayMethod, string> = { card: 'CARD', fpx: 'FPX', ewallet: 'EWALLET' }

/** SIM-FPX-7K2M9Q: the order-id alphabet, so it reads aloud as cleanly. */
function mintRef(method: PayMethod): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  return `SIM-${REF_PREFIX[method]}-${[...bytes].map((b) => alphabet[b % alphabet.length]).join('')}`
}

/**
 * The method and channel a request names, checked against the allow-list, or
 * a refusal. A request naming neither is from a storefront built before
 * payment methods existed, still cached in someone's browser while this worker
 * deploys ahead of it: that one only ever took cards, so it is filed as a card
 * with no brand rather than refused mid-checkout.
 */
function paymentOf(p: { paymentMethod?: unknown; paymentChannel?: unknown }): { method: PayMethod; channel: string } | string {
  if (p.paymentMethod === undefined && p.paymentChannel === undefined) return { method: 'card', channel: '' }
  const method = p.paymentMethod as PayMethod
  if (!Object.keys(CHANNELS).includes(method)) return 'bad payment method'
  const channel = p.paymentChannel
  if (typeof channel !== 'string' || !CHANNELS[method].includes(channel)) return 'bad payment channel'
  return { method, channel }
}

export interface OrderPayload {
  id: string
  address: {
    name: string
    email: string
    phone?: string
    country: string
    line1: string
    line2?: string
    city: string
    state: string
    postal: string
  }
  method: string
  lines: { productId: string; qty: number; finish?: string }[]
  paymentCode: string
  /** Absent from a storefront that predates them; see paymentOf. */
  paymentMethod?: PayMethod
  /** A card brand, or a bank or wallet name, from CHANNELS. */
  paymentChannel?: string
  currency?: string
}

export type PlaceResult =
  | {
      status: 200
      body: {
        id: string
        total: number
        totals: { subtotal: number; shipping: number; tax: number; total: number }
        payment: Payment
        /** This id was already stored: the answer describes that order, not this request. */
        existing?: true
      }
    }
  | { status: 400 | 409 | 503; body: { error: string; code?: 'duplicate' } }

const str = (v: unknown, max = 200): string | null =>
  typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : null

/**
 * Validates and stores one order.
 *
 * Every field is checked rather than trusted: this is a public endpoint, and
 * the only thing standing between it and the table is this function.
 */
export async function placeOrder(
  env: OrdersEnv,
  body: unknown,
  /**
   * The signed-in shopper, when there is one. Taken from the session cookie by
   * the caller and never from the payload: a request that could name its own
   * owner could file its order into someone else's account.
   */
  userId: string | null = null,
): Promise<PlaceResult> {
  if (typeof body !== 'object' || body === null) return { status: 400, body: { error: 'bad request' } }
  const p = body as Partial<OrderPayload>

  const id = str(p.id, 32)
  // The same alphabet the client draws from. A free-form id would let a caller
  // choose one that looks like someone else's.
  if (!id || !/^NX-[A-HJ-NP-Z2-9]{5}$/.test(id)) return { status: 400, body: { error: 'bad order id' } }

  /*
   * An id already stored is answered first, before any stock or catalogue
   * check. A retry of an order that landed while its answer was lost would
   * otherwise be judged afresh — and refused as sold out by the very units it
   * took — telling the shopper a paid order failed, and sending them to pay
   * again. The answer carries the stored totals, so the receipt shows what the
   * server charged. Whether this id is the caller's own retry or a collision
   * with somebody else's order is the checkout's to decide (it knows whether
   * it sent this id before). The stored totals go back only to a request
   * carrying the same email the order was placed with — a real retry resends
   * the same form, and anyone else guessing ids learns only that one is taken.
   */
  const stored = await env.ORDERS.prepare(
    `SELECT email, subtotal_cents, shipping_cents, tax_cents, total_cents, payment_method, payment_channel, payment_ref
       FROM orders WHERE id = ?1`,
  )
    .bind(id)
    .first<{
      email: string
      subtotal_cents: number
      shipping_cents: number
      tax_cents: number
      total_cents: number
      payment_method: PayMethod
      payment_channel: string
      payment_ref: string
    }>()
  if (stored) {
    const sent = typeof p.address?.email === 'string' ? p.address.email.trim().toLowerCase() : ''
    if (sent !== stored.email.trim().toLowerCase()) {
      return { status: 409, body: { error: 'That order id is already taken.', code: 'duplicate' } }
    }
    const totals = {
      subtotal: stored.subtotal_cents,
      shipping: stored.shipping_cents,
      tax: stored.tax_cents,
      total: stored.total_cents,
    }
    const payment = { method: stored.payment_method, channel: stored.payment_channel, ref: stored.payment_ref }
    return { status: 200, body: { id, total: totals.total, totals, payment, existing: true } }
  }

  // Whether this method exists at all. Whether it runs to *this* address is
  // checked below, once the country is known.
  const method = str(p.method, 20)
  if (!method) return { status: 400, body: { error: 'bad shipping method' } }

  const paymentCode = str(p.paymentCode, 40)
  if (!paymentCode || !PAYMENT_CODES.includes(paymentCode as PaymentCode)) {
    return { status: 400, body: { error: 'bad payment code' } }
  }

  const via = paymentOf(p)
  if (typeof via === 'string') return { status: 400, body: { error: via } }
  // The FPX and e-wallet simulator posts only an approval; a refusal there
  // places nothing, as a declined card does. Anything else is not a checkout.
  if (via.method !== 'card' && paymentCode !== 'succeeded') {
    return { status: 400, body: { error: 'bad payment code' } }
  }

  const a = p.address
  if (typeof a !== 'object' || a === null) return { status: 400, body: { error: 'address is required' } }
  const address = {
    name: str(a.name, 120),
    email: str(a.email, 200),
    line1: str(a.line1, 200),
    city: str(a.city, 120),
  }
  if (Object.values(address).some((v) => v === null)) {
    return { status: 400, body: { error: 'address is incomplete' } }
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(address.email!)) {
    return { status: 400, body: { error: 'bad email' } }
  }

  /*
   * The country decides what the rest of the address may say, so it is
   * resolved first and refused outright if it is not one we ship to. The
   * subdivision and postcode are then checked against that country's own
   * rules, imported from the same module the checkout form reads — when the
   * two disagreed, the form collected a valid Malaysian postcode and this
   * endpoint rejected it as a bad ZIP, which reads as a broken checkout.
   */
  const country = findCountry(str(a.country, 2) ?? '')
  if (!country) return { status: 400, body: { error: 'we do not ship there' } }

  /*
   * And the method has to be one a carrier runs to that country. Checked here
   * rather than against a flat list of three: Overnight is a domestic service,
   * and accepting it for Kuala Lumpur would take $29.95 for a delivery nobody
   * has agreed to make.
   */
  if (!methodAvailable(method, country.code)) {
    return { status: 400, body: { error: `${method} is not available to ${country.name}` } }
  }

  // Empty is the right answer for a country with no subdivisions, so this is
  // not `str`, which treats an empty string as missing.
  const state = typeof a.state === 'string' ? a.state.trim().toUpperCase() : ''
  if (!validSubdivision(country.code, state)) {
    return {
      status: 400,
      body: {
        // Two different faults wearing one status code. "bad region" for a
        // country that has no regions tells the caller to fix a field that
        // should not have been sent at all.
        error: country.subdivisions
          ? `bad ${country.subdivisionLabel!.toLowerCase()}`
          : `${country.name} addresses carry no state`,
      },
    }
  }

  const postal = str(a.postal, 12)
  if (!postal || !validPostal(country.code, postal)) {
    return { status: 400, body: { error: `bad ${country.postalLabel.toLowerCase()}` } }
  }

  // Both optional. A missing apartment line or phone number is an address
  // without them, not a bad request.
  const line2 = a.line2 === undefined || a.line2 === null ? '' : (str(a.line2, 200) ?? '')
  const phone = a.phone === undefined || a.phone === null ? '' : (str(a.phone, 32) ?? '')
  if (phone && !validPhone(phone)) return { status: 400, body: { error: 'bad phone' } }

  if (!Array.isArray(p.lines) || p.lines.length === 0 || p.lines.length > 50) {
    return { status: 400, body: { error: 'lines are required' } }
  }

  /*
   * Resolve every line against the catalogue in one query, before any of them
   * is priced. An id the catalogue does not publish is refused rather than
   * stored at whatever price the caller suggested.
   */
  const ids = p.lines.map((raw) => str(raw?.productId, 64))
  if (ids.some((id) => id === null)) return { status: 400, body: { error: 'unknown product' } }
  const catalogue = await resolve(env, ids as string[])

  const seen = new Set<string>()
  const lines: {
    productId: string
    merchantId: string
    commissionBps: number
    sku: string
    title: string
    qty: number
    unit: number
    finish: string
  }[] = []
  for (const [i, raw] of p.lines.entries()) {
    const productId = ids[i]!
    const product = catalogue.get(productId)
    if (!product) return { status: 400, body: { error: 'unknown product' } }

    /*
     * Checked against that product's own colourways, not accepted as written.
     * Refused rather than quietly dropped: a finish the server does not
     * recognise means the basket and the catalogue disagree, and silently
     * forgetting it is how a shopper receives the wrong colour.
     */
    const finish = raw?.finish === undefined || raw?.finish === null ? '' : str(raw.finish, 60)
    if (finish === null) return { status: 400, body: { error: 'bad finish' } }
    if (finish && !finishes(product).has(finish)) {
      return { status: 400, body: { error: 'unknown finish' } }
    }

    // Two finishes of one product are two lines; the same one twice is not.
    const key = `${productId}|${finish}`
    if (seen.has(key)) return { status: 400, body: { error: 'duplicate line' } }
    seen.add(key)

    const qty = raw?.qty
    if (!Number.isInteger(qty) || (qty as number) < 1 || (qty as number) > 99) {
      return { status: 400, body: { error: 'bad quantity' } }
    }
    lines.push({
      productId,
      merchantId: product.merchant_id,
      commissionBps: product.commission_bps,
      sku: product.sku,
      title: product.title,
      qty: qty as number,
      unit: product.price_minor,
      finish,
    })
  }

  const subtotal = lines.reduce((sum, l) => sum + l.unit * l.qty, 0)
  const totals = totalCents({
    subtotal,
    method: method as ShipMethod,
    country: country.code,
    state,
  })

  // Currency is a display choice; the ledger is in USD cents either way.
  const currency = str(p.currency, 3) ?? 'USD'

  /*
   * A paid order takes its units out of stock and opens one fulfilment part
   * per merchant, in the same batch as the order itself: all of it lands, or
   * none of it. A declined attempt is stored for the record and touches
   * neither — nothing was sold.
   *
   * Stock is checked here first so the refusal can name the product, and then
   * again by the stock_count CHECK (>= 0) on the UPDATE below, which is the
   * check that holds against a second checkout racing this one: the UPDATE
   * that would go negative aborts the batch.
   */
  const paid = paymentCode === 'succeeded'
  if (paid) {
    const short = shortOf(catalogue, lines)
    if (short) return { status: 409, body: { error: short } }
  }
  // [productId, qty] per line; the UPDATE sums them per product itself.
  const units = JSON.stringify(lines.map((l) => [l.productId, l.qty]))
  const payment: Payment = { ...via, ref: mintRef(via.method) }

  try {
    await env.ORDERS.batch([
      env.ORDERS.prepare(
        `INSERT INTO orders (id, email, ship_name, ship_phone, ship_country, ship_line1, ship_line2,
                             ship_city, ship_state, ship_postal,
                             method, currency, subtotal_cents, shipping_cents, tax_cents, total_cents,
                             payment_status, user_id, payment_method, payment_channel, payment_ref)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)`,
      ).bind(
        id,
        address.email,
        address.name,
        phone,
        country.code,
        address.line1,
        line2,
        address.city,
        state,
        postal,
        method,
        currency.toUpperCase(),
        totals.subtotal,
        totals.shipping,
        totals.tax,
        totals.total,
        paymentCode,
        userId,
        payment.method,
        payment.channel,
        payment.ref,
      ),
      ...lines.map((l) =>
        env.ORDERS.prepare(
          // commission_bps is the platform's rate at the moment of sale, so a
          // later change to the merchant's rate never re-prices this line.
          `INSERT INTO order_lines (order_id, product_id, merchant_id, sku, title, qty,
                                    unit_price_cents, variant, commission_bps)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
        ).bind(id, l.productId, l.merchantId, l.sku, l.title, l.qty, l.unit, l.finish, l.commissionBps),
      ),
      // One statement whatever the line count: D1 counts statements per
      // invocation, and a statement per product would double what a big
      // basket costs.
      ...(paid
        ? [
            env.ORDERS.prepare(
              `UPDATE products
                  SET stock_count = stock_count - (SELECT SUM(json_extract(value, '$[1]')) FROM json_each(?1)
                                                    WHERE json_extract(value, '$[0]') = products.id),
                      updated_at = datetime('now')
                WHERE id IN (SELECT json_extract(value, '$[0]') FROM json_each(?1))`,
            ).bind(units),
            env.ORDERS.prepare(
              // stock_taken = 1: these units came out of stock just above, so
              // cancelling this part puts them back (a backfilled part never did).
              `INSERT INTO order_fulfilments (order_id, merchant_id, stock_taken)
               SELECT DISTINCT order_id, merchant_id, 1 FROM order_lines WHERE order_id = ?1`,
            ).bind(id),
          ]
        : []),
    ])
  } catch (err) {
    const message = String(err)
    // A repeated id is a retry or a double-click, not a server fault. The
    // `code` lets the storefront tell it from running out of stock.
    if (/UNIQUE|PRIMARY KEY/i.test(message)) {
      return { status: 409, body: { error: 'order already exists', code: 'duplicate' } }
    }
    // Stock ran out between the check above and the write: another checkout
    // got there first. Read again to say which product.
    if (/CHECK constraint failed/i.test(message) && /stock_count/i.test(message)) {
      const short = shortOf(await resolve(env, [...new Set(lines.map((l) => l.productId))]), lines)
      return { status: 409, body: { error: short ?? 'Some items just sold out. Review your cart to continue.' } }
    }
    console.error('order insert failed', err)
    return { status: 503, body: { error: 'could not store order' } }
  }

  return { status: 200, body: { id, total: totals.total, totals, payment } }
}

export interface StoredOrder {
  id: string
  placedAt: string
  email: string
  address: {
    name: string
    phone: string
    country: string
    line1: string
    line2: string
    city: string
    state: string
    postal: string
  }
  method: string
  currency: string
  totals: { subtotal: number; shipping: number; tax: number; total: number }
  paymentCode: string
  payment: Payment
  lines: {
    productId: string
    sku: string
    title: string
    qty: number
    unitPriceCents: number
    finish?: string
    /** The merchant that sells it. */
    seller: string
    /** That seller's part of the order. Null unless the reader placed the order. */
    status: string | null
  }[]
  /** Delivery and refunds, per seller. Only ever present for the account that placed the order. */
  parts?: OrderPart[]
}

/** One seller's part of an order, as its buyer sees it. */
export interface OrderPart {
  seller: string
  status: string
  carrier: string | null
  tracking: string | null
  shippedAt: string | null
  deliveredAt: string | null
  /** The lines this seller ships. */
  items: { sku: string; title: string; qty: number; finish?: string }[]
  /** Refunded on those lines, one amount per currency. */
  refunded: { currency: string; minor: number }[]
}

/** Every seller's part of one order, with what each shipped and refunded. */
async function partsOf(env: OrdersEnv, orderId: string): Promise<OrderPart[]> {
  const [parts, lines, refunds] = await Promise.all([
    env.ORDERS.prepare(
      `SELECT f.merchant_id, COALESCE(m.name, '') AS seller, f.status, f.carrier, f.tracking,
              f.shipped_at, f.delivered_at
         FROM order_fulfilments f LEFT JOIN merchants m ON m.id = f.merchant_id
        WHERE f.order_id = ?1 ORDER BY f.merchant_id`,
    )
      .bind(orderId)
      .all<{
        merchant_id: string
        seller: string
        status: string
        carrier: string | null
        tracking: string | null
        shipped_at: string | null
        delivered_at: string | null
      }>(),
    env.ORDERS.prepare(
      `SELECT merchant_id, sku, title, qty, variant FROM order_lines WHERE order_id = ?1 ORDER BY title, variant`,
    )
      .bind(orderId)
      .all<{ merchant_id: string; sku: string; title: string; qty: number; variant: string }>(),
    env.ORDERS.prepare(
      `SELECT r.merchant_id, COALESCE(p.currency, 'XXX') AS currency, SUM(r.amount_minor) AS minor
         FROM refunds r LEFT JOIN products p ON p.id = r.product_id
        WHERE r.order_id = ?1
        GROUP BY r.merchant_id, COALESCE(p.currency, 'XXX') ORDER BY currency`,
    )
      .bind(orderId)
      .all<{ merchant_id: string; currency: string; minor: number }>(),
  ])
  return (parts.results ?? []).map((f) => ({
    seller: f.seller,
    status: f.status,
    carrier: f.carrier,
    tracking: f.tracking,
    shippedAt: f.shipped_at,
    deliveredAt: f.delivered_at,
    items: (lines.results ?? [])
      .filter((l) => l.merchant_id === f.merchant_id)
      .map((l) => ({ sku: l.sku, title: l.title, qty: l.qty, finish: l.variant || undefined })),
    refunded: (refunds.results ?? [])
      .filter((r) => r.merchant_id === f.merchant_id)
      .map(({ currency, minor }) => ({ currency, minor })),
  }))
}

/**
 * Reads one order back.
 *
 * The email is masked. An order id is short enough to read over the phone,
 * which is the same thing as saying it is short enough to guess, and a receipt
 * link should not hand a stranger a working address book entry.
 *
 * For the same reason, delivery (carrier, tracking number) and refunds are
 * added only when `userId` — from the session cookie, never the request — is
 * the account the order was filed to. Anyone else holding the id reads exactly
 * what they always could, and a guest order, which no account owns, never
 * carries them.
 */
export async function getOrder(env: OrdersEnv, id: string, userId: string | null = null): Promise<StoredOrder | null> {
  if (!/^NX-[A-HJ-NP-Z2-9]{5}$/.test(id)) return null

  const row = await env.ORDERS.prepare(`SELECT * FROM orders WHERE id = ?1`).bind(id).first<{
    id: string
    created_at: string
    email: string
    ship_name: string
    ship_phone: string
    ship_country: string
    ship_line1: string
    ship_line2: string
    ship_city: string
    ship_state: string
    ship_postal: string
    method: string
    currency: string
    subtotal_cents: number
    shipping_cents: number
    tax_cents: number
    total_cents: number
    payment_status: string
    user_id: string | null
    payment_method: PayMethod
    payment_channel: string
    payment_ref: string
  }>()
  if (!row) return null
  const owner = userId !== null && row.user_id === userId
  // Anyone holding the id can open the receipt, and ids are short enough to
  // guess, so only the account that placed it sees where it is going. Others
  // get the first name and the town — enough for a shared link to make sense.
  const street = (v: string | null) => (owner ? (v ?? '') : '')

  // Each line with its seller and that seller's part. The part's status is
  // delivery information, so like `parts` it goes only to the owner.
  const { results } = await env.ORDERS.prepare(
    `SELECT l.product_id, l.sku, l.title, l.qty, l.unit_price_cents, l.variant,
            COALESCE(m.name, '') AS seller, f.status
       FROM order_lines l
       LEFT JOIN merchants m ON m.id = l.merchant_id
       LEFT JOIN order_fulfilments f ON f.order_id = l.order_id AND f.merchant_id = l.merchant_id
      WHERE l.order_id = ?1
      ORDER BY l.rowid`,
  )
    .bind(id)
    .all<{
      product_id: string
      sku: string
      title: string
      qty: number
      unit_price_cents: number
      variant: string
      seller: string
      status: string | null
    }>()

  return {
    id: row.id,
    placedAt: row.created_at,
    email: maskEmail(row.email),
    address: {
      name: owner ? row.ship_name : (row.ship_name.split(/\s+/)[0] ?? ''),
      phone: street(row.ship_phone),
      country: row.ship_country ?? 'US',
      line1: street(row.ship_line1),
      line2: street(row.ship_line2),
      city: row.ship_city,
      state: row.ship_state,
      postal: street(row.ship_postal),
    },
    method: row.method,
    currency: row.currency,
    totals: {
      subtotal: row.subtotal_cents,
      shipping: row.shipping_cents,
      tax: row.tax_cents,
      total: row.total_cents,
    },
    paymentCode: row.payment_status,
    // The reference is what support would look an order up by, so it is the
    // owner's. How it was paid (a method and a brand or bank name) is not.
    payment: { method: row.payment_method, channel: row.payment_channel, ref: owner ? row.payment_ref : null },
    lines: (results ?? []).map((l) => ({
      productId: l.product_id,
      sku: l.sku,
      title: l.title,
      qty: l.qty,
      unitPriceCents: l.unit_price_cents,
      // Empty string is the storage shape for "no choice offered"; undefined is
      // what the rest of the app means by it.
      finish: l.variant || undefined,
      seller: l.seller,
      status: owner ? l.status : null,
    })),
    ...(owner ? { parts: await partsOf(env, id) } : {}),
  }
}

export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@')
  if (at < 1) return '•••'
  // One character is enough for the owner to recognise and not enough for a
  // stranger to reconstruct.
  return `${email[0]}•••${email.slice(at)}`
}
