/**
 * Order persistence in D1.
 *
 * The browser already wrote a receipt to localStorage before this is called, so
 * nothing here is on the critical path of a purchase — its job is to make an
 * order exist somewhere other than the device that placed it, which is what
 * lets /order/NX-4K2P9 open on a phone the shopper did not check out on.
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
    `SELECT id, merchant_id, sku, title, price_minor, colorways
       FROM products WHERE status = 'published' AND id IN (${marks})`,
  )
    .bind(...ids)
    .all<ProductRow>()
  return new Map((results ?? []).map((r) => [r.id, r]))
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
  currency?: string
}

export type PlaceResult =
  | { status: 200; body: { id: string; total: number } }
  | { status: 400 | 409 | 503; body: { error: string } }

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

  // Whether this method exists at all. Whether it runs to *this* address is
  // checked below, once the country is known.
  const method = str(p.method, 20)
  if (!method) return { status: 400, body: { error: 'bad shipping method' } }

  const paymentCode = str(p.paymentCode, 40)
  if (!paymentCode || !PAYMENT_CODES.includes(paymentCode as PaymentCode)) {
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

  try {
    await env.ORDERS.batch([
      env.ORDERS.prepare(
        `INSERT INTO orders (id, email, ship_name, ship_phone, ship_country, ship_line1, ship_line2,
                             ship_city, ship_state, ship_postal,
                             method, currency, subtotal_cents, shipping_cents, tax_cents, total_cents,
                             payment_status, user_id)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)`,
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
      ),
      ...lines.map((l) =>
        env.ORDERS.prepare(
          `INSERT INTO order_lines (order_id, product_id, merchant_id, sku, title, qty,
                                    unit_price_cents, variant)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`,
        ).bind(id, l.productId, l.merchantId, l.sku, l.title, l.qty, l.unit, l.finish),
      ),
    ])
  } catch (err) {
    const message = String(err)
    // A repeated id is a retry or a double-click, not a server fault, and the
    // caller already holds a receipt for it.
    if (/UNIQUE|PRIMARY KEY/i.test(message)) return { status: 409, body: { error: 'order already exists' } }
    console.error('order insert failed', err)
    return { status: 503, body: { error: 'could not store order' } }
  }

  return { status: 200, body: { id, total: totals.total } }
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
  lines: { sku: string; title: string; qty: number; unitPriceCents: number; finish?: string }[]
}

/**
 * Reads one order back.
 *
 * The email is masked. An order id is short enough to read over the phone,
 * which is the same thing as saying it is short enough to guess, and a receipt
 * link should not hand a stranger a working address book entry.
 */
export async function getOrder(env: OrdersEnv, id: string): Promise<StoredOrder | null> {
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
  }>()
  if (!row) return null

  const { results } = await env.ORDERS.prepare(
    `SELECT sku, title, qty, unit_price_cents, variant FROM order_lines WHERE order_id = ?1`,
  )
    .bind(id)
    .all<{ sku: string; title: string; qty: number; unit_price_cents: number; variant: string }>()

  return {
    id: row.id,
    placedAt: row.created_at,
    email: maskEmail(row.email),
    address: {
      name: row.ship_name,
      phone: row.ship_phone ?? '',
      country: row.ship_country ?? 'US',
      line1: row.ship_line1,
      line2: row.ship_line2 ?? '',
      city: row.ship_city,
      state: row.ship_state,
      postal: row.ship_postal,
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
    lines: (results ?? []).map((l) => ({
      sku: l.sku,
      title: l.title,
      qty: l.qty,
      unitPriceCents: l.unit_price_cents,
      // Empty string is the storage shape for "no choice offered"; undefined is
      // what the rest of the app means by it.
      finish: l.variant || undefined,
    })),
  }
}

export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@')
  if (at < 1) return '•••'
  // One character is enough for the owner to recognise and not enough for a
  // stranger to reconstruct.
  return `${email[0]}•••${email.slice(at)}`
}
