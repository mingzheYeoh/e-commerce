/**
 * The merchant console: staff authentication and the routes that can write.
 *
 * A separate worker from nexus-api, on its own origin — see
 * wrangler.console.toml for why. It shares `worker/src` so the tenancy core
 * and the credential primitives are ordinary imports.
 *
 * Every merchant route takes its tenant from the session row and from nowhere
 * else: no request body type here has a `merchantId` field, so a request
 * cannot name a tenant even dishonestly. `scopedTo` is called fresh on every
 * request — its active-merchant check runs once, when the repository is
 * vended, so a repository held across requests would keep working for a
 * merchant suspended in between. That per-request SELECT is the
 * authorisation, not overhead.
 */
import {
  registerMerchant,
  approveMerchant,
  signIn,
  signOut,
  staffSession,
  beginTotpEnrolment,
  confirmTotpEnrolment,
  type StaffEnv,
  type StaffResult,
  type StaffSession,
} from './staff-auth'
import {
  id,
  LOW_STOCK,
  OVERDUE_DAYS,
  scopedTo,
  platformWide,
  utcDay,
  Conflict,
  Invalid,
  type AuditPage,
  type Attention,
  type Balance,
  type CustomerDetail,
  type CustomerPage,
  type MerchantDetail,
  type PaymentFilter,
  type PaymentKind,
  type PaymentPage,
  type PlatformReport,
  type Fulfilment,
  type FulfilmentStatus,
  type InventoryRow,
  type Ledger,
  type OrderFilter,
  type SalesReport,
  type NewPayout,
  type NewRefund,
  type Payout,
  type Refund,
  type MerchantSummary,
  type NewProduct,
  type Overview,
  type OrderDetail,
  type OrderSummary,
  type PlatformRepository,
  type ProductPatch,
  type ProductRow,
  type Repository,
} from './tenancy'
import { guard, type IpDefences } from './auth'
import {
  MAX_LARGE_BYTES,
  MAX_PHOTOS,
  MAX_THUMB_BYTES,
  isPhotoKey,
  isPhotoName,
  isWebp,
  keyFor,
  mediaFor,
  namesIn,
  newPhotoName,
  type Media,
} from './photos'
import { reindex } from './indexing'

/*
 * Re-exported because Cloudflare resolves a Durable Object class by name from
 * the worker's own module exports. This worker hosts its own IpThrottle
 * namespace rather than binding nexus-api's, so each deploys without the other.
 */
export { IpThrottle } from './throttle'

export interface ConsoleEnv extends StaffEnv, IpDefences {
  /** Product photos. One bucket per environment, never shared. */
  MEDIA: R2Bucket
  /** Where nexus-api serves MEDIA from, ending in '/'. Photo URLs are this plus a key. */
  MEDIA_BASE: string
  /** Embeds a product's passage when it goes on sale or changes (indexing.ts). */
  AI: Ai
  /** The index nexus-api retrieves from. One per environment, never shared. */
  VECTORIZE: VectorizeIndex
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

const reply = (r: StaffResult) => json(r.body, r.status, r.headers)

/** A malformed body is read as no body, which every handler refuses with 400. */
const readBody = (request: Request): Promise<unknown> => request.json().catch(() => null)

/** The per-IP throttle, applied before any KDF or statement runs. */
async function throttled(env: ConsoleEnv, request: Request, kind: 'login' | 'signup') {
  const limited = await guard(env, request, kind)
  return limited && json(limited.body, 429, { 'retry-after': String(limited.retryAfter) })
}

type Active = Extract<StaffSession, { kind: 'active' }>

/**
 * Signed in and past the second factor, or the refusal to send.
 *
 * An enrolling session is a 403 everywhere this is used: a password alone
 * reaches nothing but the TOTP routes, /me and /signout.
 */
async function actor(env: ConsoleEnv, request: Request): Promise<Active | Response> {
  const session = await staffSession(env, request)
  if (!session) return json({ error: 'not signed in' }, 401)
  if (session.kind === 'enrolling') return json({ error: 'second factor required' }, 403)
  return session
}

/** The signed-in merchant's repository, vended now, or the refusal to send. */
async function merchantRepo(env: ConsoleEnv, request: Request): Promise<Repository | Response> {
  const session = await actor(env, request)
  if (session instanceof Response) return session
  // merchantId is never null for merchant scope (the staff table's paired
  // CHECK), but this is the line that decides tenancy, so it fails closed.
  if (session.scope !== 'merchant' || !session.merchantId) {
    return json({ error: 'not a merchant account' }, 403)
  }
  try {
    return await scopedTo(env, session.merchantId, session.staffId)
  } catch (err) {
    // A suspended seller's own request is refused, not broken.
    if (/is not active/.test(String(err))) return json({ error: 'this merchant is not active' }, 403)
    throw err
  }
}

/** The platform repository for platform staff, or the refusal to send. */
async function platformRepo(env: ConsoleEnv, request: Request): Promise<PlatformRepository | Response> {
  const session = await actor(env, request)
  if (session instanceof Response) return session
  if (session.scope !== 'platform') return json({ error: 'not a platform account' }, 403)
  return platformWide(env, session.staffId)
}

/* ---------------------------------------------------------------- orders io */

const DAY = /^\d{4}-\d{2}-\d{2}$/
/**
 * A real calendar date between 2000 and 2100. 2026-02-30 matches the pattern
 * and is not one; 9999-12-31 is one, but SQLite's date(to, '+1 day') past
 * year 9999 is NULL, and a NULL bound silently matches nothing.
 */
const isDay = (v: string) =>
  DAY.test(v) && v >= '2000-01-01' && v <= '2100-12-31' && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v)

/** from/to as inclusive UTC dates, defaulting to the last 30 days. */
function orderRange(url: URL): { from: string; to: string } | string {
  const from = url.searchParams.get('from') || utcDay(29)
  const to = url.searchParams.get('to') || utcDay(0)
  if (!isDay(from) || !isDay(to)) return 'Dates are YYYY-MM-DD, between 2000 and 2100.'
  if (from > to) return 'The start date is after the end date.'
  return { from, to }
}

/** A report's range: three years at most, which is 157 weekly bars. */
function reportRange(url: URL): { from: string; to: string } | string {
  const range = orderRange(url)
  if (typeof range === 'string') return range
  const days = (Date.parse(range.to) - Date.parse(range.from)) / 86_400_000 + 1
  return days > 1096 ? 'A report covers three years at most.' : range
}

const PART_STATUSES = new Set<string>(['pending', 'shipped', 'delivered', 'cancelled'])
/** One page of the order history, unless the request asks for fewer or more (up to 200). */
const ORDER_PAGE = 50
/** A cursor is the last order's `created_at|id`, as the previous page's `next` gave it. */
const CURSOR = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\|([A-Za-z0-9_-]{1,64})$/

/** The order history's filters. Every one is optional; with none, every paid order of yours. */
function orderFilter(url: URL): OrderFilter | string {
  const p = url.searchParams
  const from = p.get('from') || undefined
  const to = p.get('to') || undefined
  if ((from && !isDay(from)) || (to && !isDay(to))) return 'Dates are YYYY-MM-DD, between 2000 and 2100.'
  if (from && to && from > to) return 'The start date is after the end date.'
  const status = p.get('status') || undefined
  if (status && !PART_STATUSES.has(status)) return 'status is pending, shipped, delivered or cancelled.'
  const q = (p.get('q') ?? '').trim()
  if (q.length > 40) return 'Search by at most 40 characters of an order id.'
  const cursor = p.get('before')
  const at = cursor === null ? null : cursor.match(CURSOR)
  if (cursor !== null && !at) return 'before is the next value of the page before.'
  const limit = p.get('limit') === null ? ORDER_PAGE : Number(p.get('limit'))
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) return 'limit is a whole number from 1 to 200.'
  return {
    from,
    to,
    status: status as FulfilmentStatus | undefined,
    q: q || undefined,
    before: at ? { at: at[1], id: at[2] } : undefined,
    limit,
  }
}

/** Orders carry a name and a delivery address, and money is money: no shared cache may keep either. */
const PRIVATE = { 'cache-control': 'no-store' }

const orderSummary = (o: OrderSummary) => ({
  id: o.id,
  placedAt: o.created_at,
  method: o.method,
  status: o.payment_status,
  items: o.items,
  totals: o.totals,
  fulfilment: o.fulfilment,
})

const fulfilmentOut = (f: Fulfilment) => ({
  merchantId: f.merchant_id,
  status: f.status,
  carrier: f.carrier,
  tracking: f.tracking,
  shippedAt: f.shipped_at,
  deliveredAt: f.delivered_at,
  updatedAt: f.updated_at,
})

const refundOut = (r: Refund) => ({
  id: r.id,
  orderId: r.order_id,
  productId: r.product_id,
  finish: r.variant || null,
  qty: r.qty,
  amountMinor: r.amount_minor,
  currency: r.currency,
  reason: r.reason,
})

const balanceOut = (b: Balance) => ({
  merchantId: b.merchant_id,
  currency: b.currency,
  currentBps: b.current_bps,
  gross: b.gross,
  refunds: b.refunds,
  commission: b.commission,
  payouts: b.payouts,
  available: b.available,
  // A negative balance is money the merchant owes the platform, said outright.
  owes: b.owes,
})

const payoutOut = (p: Payout) => ({
  id: p.id,
  merchantId: p.merchant_id,
  currency: p.currency,
  amountMinor: p.amount_minor,
  reference: p.reference,
})

/** Which platform staff member recorded it stays the platform's business. */
const paidOut = (p: Payout & { created_at: string }) => ({ ...payoutOut(p), createdAt: p.created_at })

const inventoryOut = (p: InventoryRow) => ({
  id: p.id,
  sku: p.sku,
  title: p.title,
  category: p.category,
  status: p.status,
  priceMinor: p.price_minor,
  currency: p.currency,
  stockCount: p.stock_count,
  sold30d: p.sold_30d,
})

const salesOut = (r: SalesReport) => ({
  ...r,
  products: r.products.map((p) => ({
    productId: p.product_id,
    title: p.title,
    currency: p.currency,
    gross: p.gross,
    net: p.net,
    units: p.units,
  })),
})

/** A merchant's own ledger: the merchant id on every row would only repeat the session's. */
const ledgerOut = (l: Ledger) => ({
  currentBps: l.current_bps,
  summary: l.summary.map(({ merchant_id: _m, ...s }) => s),
  entries: l.entries.map(({ merchant_id: _m, ...e }) => e),
})

const orderDetail = (o: OrderDetail) => ({
  id: o.id,
  placedAt: o.created_at,
  method: o.method,
  status: o.payment_status,
  shipTo: {
    name: o.ship_name,
    line1: o.ship_line1,
    line2: o.ship_line2,
    city: o.ship_city,
    state: o.ship_state,
    postal: o.ship_postal,
    country: o.ship_country,
  },
  lines: o.lines.map((l) => ({
    productId: l.product_id,
    merchantId: l.merchant_id,
    sku: l.sku,
    title: l.title,
    finish: l.variant || null,
    qty: l.qty,
    unitMinor: l.unit_price_cents,
    currency: l.currency,
    refundedQty: l.refunded_qty,
    refundedMinor: l.refunded_minor,
  })),
  totals: o.totals,
  fulfilment: o.fulfilment.map(fulfilmentOut),
  refunds: o.refunds.map((r) => ({
    id: r.id,
    merchantId: r.merchant_id,
    productId: r.product_id,
    finish: r.variant || null,
    qty: r.qty,
    amountMinor: r.amount_minor,
    currency: r.currency,
    reason: r.reason,
    by: r.actor_scope,
    at: r.created_at,
  })),
})

const overviewOut = (o: Overview) => ({
  ...o,
  top: o.top.map((t) => ({ productId: t.product_id, title: t.title, currency: t.currency, minor: t.minor, qty: t.qty })),
  lowStock: o.lowStock.map((p) => ({ id: p.id, title: p.title, stockCount: p.stock_count })),
})

/** The platform page shows neither top products nor low stock, so neither is sent. */
const platformOverviewOut = ({ revenue, gross, orders, trend, products }: Overview) => ({
  revenue,
  gross,
  orders,
  trend,
  products,
})

/* ---------------------------------------------------------- platform io */

/** The platform's order list shows whose lines each order holds. */
const platformOrderSummary = (o: OrderSummary) => ({ ...orderSummary(o), merchantIds: o.merchant_ids })

const PAYMENT_KINDS = new Set<string>(['charge', 'refund', 'payout'])
/** A payments cursor is the last entry's `at|rank|id`. */
const PAYMENT_CURSOR = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\|([123])\|([A-Za-z0-9_-]{1,64})$/
/** A customers cursor is the last account's `created_at|id`. */
const CUSTOMER_CURSOR = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\|([A-Za-z0-9_-]{1,64})$/
const ID = /^[A-Za-z0-9_-]{1,64}$/

/** A page size: ORDER_PAGE unless asked, 1 to 200. */
function pageSize(url: URL): number | string {
  const raw = url.searchParams.get('limit')
  const limit = raw === null ? ORDER_PAGE : Number(raw)
  return Number.isInteger(limit) && limit >= 1 && limit <= 200 ? limit : 'limit is a whole number from 1 to 200.'
}

/** The payments ledger's filters; the range defaults to the last 30 days and covers three years at most. */
function paymentFilter(url: URL): (PaymentFilter & { limit: number }) | string {
  const p = url.searchParams
  const range = reportRange(url)
  if (typeof range === 'string') return range
  const kind = p.get('type') || undefined
  if (kind && !PAYMENT_KINDS.has(kind)) return 'type is charge, refund or payout.'
  const merchantId = p.get('merchant') || undefined
  if (merchantId && !ID.test(merchantId)) return 'not a merchant id'
  const currency = p.get('currency') || undefined
  if (currency && !/^[A-Z]{3}$/.test(currency)) return 'currency is a three-letter code, such as USD.'
  const cursor = p.get('before')
  const at = cursor === null ? null : cursor.match(PAYMENT_CURSOR)
  if (cursor !== null && !at) return 'before is the next value of the page before.'
  const limit = pageSize(url)
  if (typeof limit === 'string') return limit
  return {
    ...range,
    kind: kind as PaymentKind | undefined,
    merchantId,
    currency,
    before: at ? { at: at[1], rank: Number(at[2]), id: at[3] } : undefined,
    limit,
  }
}

const paymentsOut = (page: PaymentPage, limit: number) => {
  const shown = page.entries.slice(0, limit)
  const last = shown[shown.length - 1]
  return {
    next: page.entries.length > limit ? `${last.at}|${last.rank}|${last.id}` : null,
    entries: shown.map((e) => ({
      at: e.at,
      kind: e.kind,
      id: e.id,
      ref: e.ref,
      merchantIds: e.merchant_ids,
      currency: e.currency,
      amount: e.amount,
      goods: e.goods,
      shipping: e.shipping,
      tax: e.tax,
      paymentMethod: e.payment_method,
      paymentChannel: e.payment_channel,
    })),
    totals: page.totals.map((t) => ({
      currency: t.currency,
      charges: t.charges,
      charged: t.charged,
      goods: t.goods,
      shipping: t.shipping,
      tax: t.tax,
      refunds: t.refunds,
      refunded: t.refunded,
      payouts: t.payouts,
      paidOut: t.paid_out,
    })),
  }
}

const reportOut = (r: PlatformReport) => ({
  charges: r.charges,
  merchants: r.merchants.map((m) => ({
    merchantId: m.merchant_id,
    name: m.name,
    currency: m.currency,
    gross: m.gross,
    refunds: m.refunds,
    net: m.net,
    commission: m.commission,
    orders: m.orders,
    units: m.units,
  })),
  health: r.health.map((h) => ({
    merchantId: h.merchant_id,
    parts: h.parts,
    cancelled: h.cancelled,
    shipped: h.shipped,
    avgShipSeconds: h.avg_ship_seconds,
  })),
  signups: r.signups,
  buyers: r.buyers,
})

const attentionOut = (a: Attention) => ({
  pendingApplications: a.pending_applications,
  toShip: a.to_ship,
  overdue: a.overdue,
  overdueDays: OVERDUE_DAYS,
  lowStockAt: LOW_STOCK,
  owingMerchants: a.owing_merchants,
  owing: a.owing.map((o) => ({ merchantId: o.merchant_id, name: o.name, currency: o.currency, available: o.available })),
  lowStock: a.low_stock.map((l) => ({ merchantId: l.merchant_id, name: l.name, products: l.products })),
})

const merchantDetailOut = (m: MerchantDetail) => ({
  id: m.merchant_id,
  name: m.name,
  slug: m.slug,
  status: m.status,
  createdAt: m.created_at,
  settlementCurrency: m.settlement_currency,
  commissionBps: m.commission_bps,
  staff: m.staff.map((s) => ({ id: s.id, email: s.email, role: s.role, totpEnrolled: s.totp_enrolled, createdAt: s.created_at })),
  products: {
    draft: m.products.draft,
    published: m.products.published,
    archived: m.products.archived,
    lowStock: m.products.low_stock,
    outOfStock: m.products.out_of_stock,
  },
  low: m.low.map((p) => ({ id: p.id, title: p.title, stockCount: p.stock_count })),
  lowStockAt: LOW_STOCK,
  health: {
    toShip: m.health.to_ship,
    overdue: m.health.overdue,
    overdueDays: OVERDUE_DAYS,
    parts: m.health.parts,
    shipped: m.health.shipped,
    cancelled: m.health.cancelled,
    avgShipSeconds: m.health.avg_ship_seconds,
  },
  balances: m.balances.map(balanceOut),
})

/** A shopper account as the platform may see it: contact and standing, never a credential. */
const customerOut = (c: CustomerPage['customers'][number]) => ({
  id: c.id,
  email: c.email,
  name: c.name,
  createdAt: c.created_at,
  verified: c.verified,
  twoFactor: c.two_factor,
  orders: c.orders,
  lastOrderAt: c.last_order_at,
  spend: c.spend,
})

const customerDetailOut = (c: CustomerDetail) => ({
  ...customerOut(c),
  refunded: c.refunded,
  recent: c.recent.map((o) => ({
    id: o.id,
    placedAt: o.created_at,
    currency: o.currency,
    total: o.total,
    items: o.items,
    fulfilment: o.fulfilment,
  })),
})

const merchantOut = (m: MerchantSummary) => ({
  id: m.merchant_id,
  name: m.name,
  slug: m.slug,
  status: m.status,
  createdAt: m.created_at,
  productCount: m.product_count,
  revenue: m.revenue,
})

const auditOut = (a: AuditPage) => ({
  merchantId: a.merchant_id,
  next: a.next,
  merchants: a.merchants,
  entries: a.entries.map((e) => ({
    seq: e.seq,
    id: e.id,
    at: e.at,
    actorId: e.actor_id,
    actorEmail: e.actor_email,
    actorScope: e.actor_scope,
    merchantId: e.merchant_id,
    merchantName: e.merchant_name,
    action: e.action,
    subject: e.subject,
  })),
})

/* ------------------------------------------------------------- products io */

/**
 * Merchant text as it will be stored: whitespace collapsed and square brackets
 * turned round. These fields reach the AI's context, where a passage header is
 * `[id] title` on its own line — a newline and a bracket inside a spec value
 * could otherwise forge another merchant's product entry next to the real ones.
 */
const clean = (v: string) => v.replace(/\s+/g, ' ').replace(/\[/g, '(').replace(/\]/g, ')').trim()

const text = (v: unknown, max: number): string | null =>
  typeof v === 'string' && clean(v) && clean(v).length <= max ? clean(v) : null

/** A whole, non-negative number: what price_minor and stock_count accept. */
const whole = (v: unknown): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null

const STATUSES = new Set(['draft', 'published', 'archived'])

/**
 * The storefront filters by these exact ids (`src/data/categories.ts`), so a
 * product filed under anything else is published into a category no shopper
 * can reach. The console's select offers only these; this is the check that
 * does not depend on the request coming from the console.
 */
const CATEGORIES = new Set(['phones', 'audio', 'peripherals', 'imaging', 'computing'])

const fields = (body: unknown): Record<string, unknown> =>
  typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}

/**
 * Only the named fields are copied out of the body. Anything else — a
 * merchantId, a rating, a review_count — never reaches the repository,
 * because there is no line here that would carry it.
 */
function newProduct(body: unknown): NewProduct | string {
  const p = fields(body)
  const sku = text(p.sku, 64)
  const title = text(p.title, 200)
  const brand = text(p.brand, 80)
  const category = text(p.category, 80)
  const priceMinor = whole(p.priceMinor)
  if (!sku || !title || !brand || !category) return 'A product needs a SKU, title, brand and category.'
  if (priceMinor === null) return 'priceMinor is a whole number of minor units, zero or more.'
  if (!CATEGORIES.has(category)) return 'category is one of the storefront categories.'
  return { sku, title, brand, category, priceMinor }
}

function productPatch(body: unknown): ProductPatch | string {
  const p = fields(body)
  const patch: ProductPatch = {}
  if (p.title !== undefined) {
    const title = text(p.title, 200)
    if (!title) return 'A title cannot be empty.'
    patch.title = title
  }
  if (p.priceMinor !== undefined) {
    const priceMinor = whole(p.priceMinor)
    if (priceMinor === null) return 'priceMinor is a whole number of minor units, zero or more.'
    patch.priceMinor = priceMinor
  }
  if (p.stockCount !== undefined) {
    const stockCount = whole(p.stockCount)
    if (stockCount === null) return 'stockCount is a whole number, zero or more.'
    patch.stockCount = stockCount
  }
  if (p.status !== undefined) {
    if (typeof p.status !== 'string' || !STATUSES.has(p.status)) {
      return 'status is draft, published or archived.'
    }
    patch.status = p.status
  }
  if (p.category !== undefined) {
    if (typeof p.category !== 'string' || !CATEGORIES.has(p.category)) {
      return 'category is one of the storefront categories.'
    }
    patch.category = p.category
  }
  if (p.specsSummary !== undefined) {
    // Blank boxes are dropped rather than refused: a draft may be half written.
    // Publishing is what insists on all three.
    if (!Array.isArray(p.specsSummary) || p.specsSummary.length > 3) return 'Up to three highlights.'
    const lines: string[] = []
    for (const v of p.specsSummary) {
      if (typeof v !== 'string') return 'Highlights are text.'
      if (clean(v).length > 60) return 'Each highlight is 60 characters or fewer.'
      if (clean(v)) lines.push(clean(v))
    }
    patch.specsSummary = lines
  }
  if (p.specs !== undefined) {
    if (!Array.isArray(p.specs) || p.specs.length > 20) return 'Up to twenty specification rows.'
    const rows: { label: string; value: string }[] = []
    for (const r of p.specs) {
      const { label, value } = fields(r)
      if (typeof label !== 'string' || typeof value !== 'string') return 'A specification row is a label and a value.'
      const [l, v] = [clean(label), clean(value)]
      if (!l && !v) continue
      if (!l || !v) return 'Every specification row needs both a name and a value.'
      if (l.length > 40 || v.length > 120) return 'Specification names are 40 characters and values 120 at most.'
      rows.push({ label: l, value: v })
    }
    patch.specs = rows
  }
  if (Object.keys(patch).length === 0) return 'Nothing to change.'
  return patch
}

/* ------------------------------------------------------- fulfilment, money */

/**
 * A refund as a request may state it. The line is named by product and finish
 * (the order line's key); the merchant is never taken from the body — the
 * repository finds the line through the session's scope, or not at all.
 */
function newRefund(body: unknown): NewRefund | string {
  const p = fields(body)
  const productId = text(p.productId, 64)
  const variant = p.finish === undefined || p.finish === null || p.finish === '' ? '' : text(p.finish, 60)
  const qty = p.qty === undefined ? 0 : whole(p.qty)
  const amountMinor = p.amountMinor === undefined ? undefined : whole(p.amountMinor)
  const reason = text(p.reason, 200)
  if (!productId || variant === null) return 'Name the line to refund by productId and finish.'
  if (qty === null || qty > 99) return 'qty is a whole number of units, 0 to 99.'
  if (amountMinor === null || amountMinor === 0) return 'amountMinor is a whole number of minor units, more than zero.'
  if (qty === 0 && amountMinor === undefined) return 'A refund is for at least one unit, or states an amount.'
  if (!reason) return 'Give a reason, 200 characters at most.'
  return { productId, variant, qty, amountMinor, reason }
}

function newPayout(body: unknown): NewPayout | string {
  const p = fields(body)
  const currency = typeof p.currency === 'string' && /^[A-Z]{3}$/.test(p.currency) ? p.currency : null
  const amountMinor = whole(p.amountMinor)
  const reference = text(p.reference, 120)
  if (!currency || currency === 'XXX') return 'currency is a three-letter code, such as USD.'
  if (!amountMinor) return 'amountMinor is a whole number of minor units, more than zero.'
  if (!reference) return 'Give the period or reference this payout covers, 120 characters at most.'
  return { currency, amountMinor, reference }
}

/**
 * A repository write's answer as a response: null is 404 (not this scope's,
 * the same as not there at all), a Conflict is 409 with its own message.
 */
async function outcome<T>(write: () => Promise<T | null>, out: (v: T) => unknown, status = 200): Promise<Response> {
  try {
    const value = await write()
    return value === null ? json({ error: 'not found' }, 404) : json(out(value), status)
  } catch (err) {
    if (err instanceof Conflict) return json({ error: err.message }, 409)
    if (err instanceof Invalid) return json({ error: err.message }, 400)
    throw err
  }
}

const parse = <T>(s: string, fallback: T): T => {
  try {
    return (JSON.parse(s) as T) ?? fallback
  } catch {
    return fallback
  }
}

/**
 * What this product still lacks before it can go on sale, as one sentence,
 * or null if nothing.
 *
 * The storefront renders `media.thumb`, `media.gallery` and three highlights
 * unconditionally, so a product without them reaches the shop grid as a
 * broken card. Refused here, at the write, rather than tolerated at the
 * render — and every gap is named at once, so a merchant fixes them in one
 * pass instead of discovering them one refusal at a time.
 */
function unpublishable(priceMinor: number, specsSummary: string[], media: string): string | null {
  const m = parse<{ thumb?: unknown; gallery?: unknown }>(media, {})
  const missing: string[] = []
  if (!m.thumb || !Array.isArray(m.gallery) || m.gallery.length === 0) missing.push('at least one photo')
  if (priceMinor === 0) missing.push('a price')
  if (specsSummary.length < 3) missing.push(`${3 - specsSummary.length} more highlight${specsSummary.length === 2 ? '' : 's'}`)
  return missing.length ? `Before publishing, add ${missing.join(', ')}.` : null
}

const product = (r: ProductRow) => ({
  id: r.id,
  merchantId: r.merchant_id,
  sku: r.sku,
  title: r.title,
  brand: r.brand,
  category: r.category,
  priceMinor: r.price_minor,
  currency: r.currency,
  status: r.status,
  stockCount: r.stock_count,
  specsSummary: parse<string[]>(r.specs_summary, []),
  specs: parse<{ label: string; value: string }[]>(r.specs, []),
  media: parse<Partial<Media>>(r.media, {}),
})

/* ------------------------------------------------------------------ routes */

const PRODUCT = /^\/api\/merchant\/products\/([^/]+)$/
const PHOTOS = /^\/api\/merchant\/products\/([^/]+)\/photos$/
const PHOTO = /^\/api\/merchant\/products\/([^/]+)\/photos\/([^/]+)$/
const PHOTO_MAIN = /^\/api\/merchant\/products\/([^/]+)\/photos\/([^/]+)\/main$/
const APPROVE = /^\/api\/platform\/merchants\/([^/]+)\/approve$/
const ORDER = /^\/api\/merchant\/orders\/([^/]+)$/
const ORDER_ACTION = /^\/api\/merchant\/orders\/([^/]+)\/(ship|deliver|cancel|refunds)$/
const TRANSITION = /^\/api\/platform\/merchants\/([^/]+)\/(suspend|restore)$/
const PLATFORM_ORDER = /^\/api\/platform\/orders\/([^/]+)$/
const PLATFORM_REFUND = /^\/api\/platform\/orders\/([^/]+)\/refunds$/
const COMMISSION = /^\/api\/platform\/merchants\/([^/]+)\/commission$/
const PAYOUTS = /^\/api\/platform\/merchants\/([^/]+)\/payouts$/
const PART_CANCEL = /^\/api\/platform\/orders\/([^/]+)\/parts\/([^/]+)\/cancel$/
const PLATFORM_MERCHANT = /^\/api\/platform\/merchants\/([^/]+)$/
const MERCHANT_SALES = /^\/api\/platform\/merchants\/([^/]+)\/sales$/
const CUSTOMER = /^\/api\/platform\/customers\/([^/]+)$/

async function route(request: Request, env: ConsoleEnv, url: URL, ctx: ExecutionContext): Promise<Response> {
  const path = url.pathname
  const method = request.method

  /* ------------------------------------------------ staff authentication */

  if (path === '/api/staff/register' && method === 'POST') {
    return (
      (await throttled(env, request, 'signup')) || reply(await registerMerchant(env, await readBody(request)))
    )
  }

  if (path === '/api/staff/signin' && method === 'POST') {
    return (
      (await throttled(env, request, 'login')) || reply(await signIn(env, await readBody(request), request))
    )
  }

  if (path === '/api/staff/signout' && method === 'POST') return reply(await signOut(env, request))

  /* Where the console should send this browser. Not signed in is an answer,
     not an error, and an enrolling session learns nothing about the merchant. */
  if (path === '/api/staff/me' && method === 'GET') {
    const session = await staffSession(env, request)
    if (!session) return json({ kind: null })
    if (session.kind === 'enrolling') return json({ kind: 'enrolling' })
    if (session.scope === 'platform') return json({ kind: 'active', scope: 'platform' })
    // Read directly rather than through scopedTo, which refuses a suspended
    // merchant: this is the one place a suspended seller is told why.
    const merchant = await env.ORDERS.prepare(`SELECT name, slug, status FROM merchants WHERE id = ?1`)
      .bind(session.merchantId)
      .first<{ name: string; slug: string; status: string }>()
    return json({ kind: 'active', scope: 'merchant', merchant })
  }

  if ((path === '/api/staff/totp/begin' || path === '/api/staff/totp/confirm') && method === 'POST') {
    const session = await staffSession(env, request)
    if (!session) return json({ error: 'not signed in' }, 401)
    if (session.kind !== 'enrolling') return json({ error: 'already signed in' }, 403)
    return reply(
      path.endsWith('/begin')
        ? await beginTotpEnrolment(env, session)
        : await confirmTotpEnrolment(env, session, await readBody(request)),
    )
  }

  /* --------------------------------------------------- merchant products */

  if (path === '/api/merchant/products' && (method === 'GET' || method === 'POST')) {
    const repo = await merchantRepo(env, request)
    if (repo instanceof Response) return repo
    if (method === 'GET') return json({ products: (await repo.products.list()).map(product) })

    const input = newProduct(await readBody(request))
    if (typeof input === 'string') return json({ error: input }, 400)
    try {
      return json(product(await repo.products.create(input)), 201)
    } catch (err) {
      // (merchant_id, sku) is unique per merchant, so this names only the
      // caller's own catalogue.
      if (/UNIQUE/i.test(String(err))) return json({ error: 'You already have a product with that SKU.' }, 409)
      throw err
    }
  }

  const productId = path.match(PRODUCT)?.[1]
  if (productId && method === 'PATCH') {
    const repo = await merchantRepo(env, request)
    if (repo instanceof Response) return repo
    const patch = productPatch(await readBody(request))
    if (typeof patch === 'string') return json({ error: patch }, 400)
    // Someone else's product is a 404, not a 403: the repository cannot see
    // it, and "exists but not yours" would confirm the id to a stranger.
    const existing = await repo.products.get(productId)
    if (!existing) return json({ error: 'not found' }, 404)
    // Checked on the row as it will be, so emptying a highlight or zeroing the
    // price of something already on sale is refused too, not only publishing.
    if ((patch.status ?? existing.status) === 'published') {
      const why = unpublishable(
        patch.priceMinor ?? existing.price_minor,
        patch.specsSummary ?? parse<string[]>(existing.specs_summary, []),
        existing.media,
      )
      if (why) return json({ error: why }, 409)
    }
    const row = await repo.products.update(productId, patch)
    if (!row) return json({ error: 'not found' }, 404)
    // After the response and never in its way: the AI index is a copy of D1,
    // and rag.ts checks every hit against D1 while the copy catches up.
    ctx.waitUntil(reindex(env, existing, row))
    return json(product(row))
  }

  /* ----------------------------------------------------- product photos */

  const uploadTo = path.match(PHOTOS)?.[1]
  if (uploadTo && method === 'POST') {
    const repo = await merchantRepo(env, request)
    if (repo instanceof Response) return repo
    const existing = await repo.products.get(uploadTo)
    if (!existing) return json({ error: 'not found' }, 404)
    // merchant_id from the row the scoped repository returned, so it is the
    // session's merchant: the storage key cannot name anyone else's folder.
    const names = namesIn(existing.media, env.MEDIA_BASE, existing.merchant_id, existing.id)
    if (!names) return json({ error: "This product's photos are not managed in the console." }, 409)
    if (names.length >= MAX_PHOTOS) return json({ error: `A product has at most ${MAX_PHOTOS} photos.` }, 409)

    // formData() buffers the whole body, and an isolate has 128MB against a
    // 100MB request limit, so the cap has to be enforced before it runs.
    // Browsers always send content-length for a FormData fetch.
    const length = Number(request.headers.get('content-length'))
    if (!length || length > MAX_LARGE_BYTES + MAX_THUMB_BYTES + 64_000) {
      return json({ error: 'That photo is too large, even after resizing.' }, 413)
    }
    const form = await request.formData().catch(() => null)
    const large = form?.get('large')
    const thumb = form?.get('thumb')
    if (!(large instanceof File) || !(thumb instanceof File)) {
      return json({ error: 'Send the photo as two files, large and thumb.' }, 400)
    }
    if (large.size > MAX_LARGE_BYTES || thumb.size > MAX_THUMB_BYTES) {
      return json({ error: 'That photo is too large, even after resizing.' }, 413)
    }
    const [largeBytes, thumbBytes] = await Promise.all([large.arrayBuffer(), thumb.arrayBuffer()])
    // The bytes, not the file name or the declared type: both are the client's word.
    if (!isWebp(new Uint8Array(largeBytes)) || !isWebp(new Uint8Array(thumbBytes))) {
      return json({ error: 'Photos are uploaded as webp.' }, 415)
    }

    const name = newPhotoName()
    const keys = [keyFor(existing.merchant_id, existing.id, name, 1600), keyFor(existing.merchant_id, existing.id, name, 400)]
    // Only keys nexus-api will serve. A product id of another shape (the
    // seeded catalogue's `iphone-18-pro`) would store a photo nobody can load.
    if (!isPhotoKey(keys[0])) return json({ error: "This product's photos are not managed in the console." }, 409)
    const meta = { httpMetadata: { contentType: 'image/webp' } }
    const cleanUp = () =>
      env.MEDIA.delete(keys).catch((err) => console.error('orphaned photo objects', { keys, err }))

    let row: ProductRow | null
    try {
      await Promise.all([env.MEDIA.put(keys[0], largeBytes, meta), env.MEDIA.put(keys[1], thumbBytes, meta)])
      const media = mediaFor(env.MEDIA_BASE, existing.merchant_id, existing.id, [...names, name])
      row = await repo.products.setMedia(existing.id, media, existing.media)
    } catch (err) {
      // The objects go in first, so any failure after that takes them back out.
      await cleanUp()
      throw err
    }
    if (!row) {
      // Lost a race with another change to this product's photos.
      await cleanUp()
      return json({ error: 'The photos changed while this one uploaded. Reload and try again.' }, 409)
    }
    return json(product(row), 201)
  }

  const photo = path.match(PHOTO_MAIN) ?? path.match(PHOTO)
  const isMain = PHOTO_MAIN.test(path)
  if (photo && ((isMain && method === 'POST') || (!isMain && method === 'DELETE'))) {
    const [, productId2, name] = photo
    const repo = await merchantRepo(env, request)
    if (repo instanceof Response) return repo
    const existing = await repo.products.get(productId2)
    if (!existing) return json({ error: 'not found' }, 404)
    const names = namesIn(existing.media, env.MEDIA_BASE, existing.merchant_id, existing.id)
    if (!names) return json({ error: "This product's photos are not managed in the console." }, 409)
    if (!isPhotoName(name) || !names.includes(name)) return json({ error: 'not found' }, 404)

    const rest = names.filter((n) => n !== name)
    if (!isMain && rest.length === 0 && existing.status === 'published') {
      return json({ error: 'A published product keeps at least one photo. Unpublish it first.' }, 409)
    }
    const media = mediaFor(env.MEDIA_BASE, existing.merchant_id, existing.id, isMain ? [name, ...rest] : rest)
    const row = await repo.products.setMedia(existing.id, media, existing.media)
    if (!row) return json({ error: 'The photos changed in the meantime. Reload and try again.' }, 409)
    if (!isMain) {
      // After the row stops pointing at them, so a failure here leaves an
      // unreferenced object rather than a broken image.
      await env.MEDIA.delete([
        keyFor(existing.merchant_id, existing.id, name, 1600),
        keyFor(existing.merchant_id, existing.id, name, 400),
      ]).catch((err) => console.error('photo objects not deleted', { name, err }))
    }
    return json(product(row))
  }

  /* --------------------------------------------- merchant orders, overview */

  if (path === '/api/merchant/overview' && method === 'GET') {
    const repo = await merchantRepo(env, request)
    if (repo instanceof Response) return repo
    return json(overviewOut(await repo.stats.overview()))
  }

  if (path === '/api/merchant/orders' && method === 'GET') {
    const repo = await merchantRepo(env, request)
    if (repo instanceof Response) return repo
    const filter = orderFilter(url)
    if (typeof filter === 'string') return json({ error: filter }, 400)
    const limit = filter.limit ?? ORDER_PAGE
    // One past the page comes back exactly so a next page can be offered
    // without a count query, and only when there is one.
    const orders = await repo.orders.list(filter)
    const page = orders.slice(0, limit)
    const last = page[page.length - 1]
    return json(
      {
        from: filter.from ?? null,
        to: filter.to ?? null,
        next: orders.length > limit ? `${last.created_at}|${last.id}` : null,
        orders: page.map(orderSummary),
      },
      200,
      PRIVATE,
    )
  }

  /* The back office's reads. Every one is scoped by the session and carries
     money or order data, so none of them may be cached. */

  if (path === '/api/merchant/queue' && method === 'GET') {
    const repo = await merchantRepo(env, request)
    if (repo instanceof Response) return repo
    const q = await repo.stats.queue()
    return json({ toShip: q.to_ship, lowStock: q.low_stock, outOfStock: q.out_of_stock, lowStockAt: LOW_STOCK }, 200, PRIVATE)
  }

  if (path === '/api/merchant/reports/sales' && method === 'GET') {
    const repo = await merchantRepo(env, request)
    if (repo instanceof Response) return repo
    const range = reportRange(url)
    if (typeof range === 'string') return json({ error: range }, 400)
    return json(salesOut(await repo.stats.sales(range)), 200, PRIVATE)
  }

  if (path === '/api/merchant/inventory' && method === 'GET') {
    const repo = await merchantRepo(env, request)
    if (repo instanceof Response) return repo
    return json({ lowStockAt: LOW_STOCK, products: (await repo.products.inventory()).map(inventoryOut) }, 200, PRIVATE)
  }

  if (path === '/api/merchant/finance/ledger' && method === 'GET') {
    const repo = await merchantRepo(env, request)
    if (repo instanceof Response) return repo
    const range = reportRange(url)
    if (typeof range === 'string') return json({ error: range }, 400)
    return json({ ...range, ...ledgerOut(await repo.finance.ledger(range)) }, 200, PRIVATE)
  }

  if (path === '/api/merchant/finance/payouts' && method === 'GET') {
    const repo = await merchantRepo(env, request)
    if (repo instanceof Response) return repo
    return json({ payouts: (await repo.finance.payouts()).map(paidOut) }, 200, PRIVATE)
  }

  const orderId = path.match(ORDER)?.[1]
  if (orderId && method === 'GET') {
    const repo = await merchantRepo(env, request)
    if (repo instanceof Response) return repo
    // An order with none of this merchant's lines is a 404, the same answer
    // as no such order: "exists, not yours" would confirm the id.
    const order = await repo.orders.get(orderId)
    return order ? json(orderDetail(order), 200, PRIVATE) : json({ error: 'not found' }, 404)
  }

  /* The merchant's own part of an order: ship, deliver, cancel, refund a line.
     Another merchant's order is a 404 from the repository, like the read. */
  const orderAction = path.match(ORDER_ACTION)
  if (orderAction && method === 'POST') {
    const repo = await merchantRepo(env, request)
    if (repo instanceof Response) return repo
    const [, target, verb] = orderAction
    const body = fields(await readBody(request))
    if (verb === 'ship') {
      const carrier = text(body.carrier, 60)
      const tracking = text(body.tracking, 60)
      if (!carrier || !tracking) {
        return json({ error: 'A shipment needs a carrier and a tracking number, 60 characters each at most.' }, 400)
      }
      return outcome(() => repo.fulfilment.ship(target, { carrier, tracking }), fulfilmentOut)
    }
    if (verb === 'deliver') return outcome(() => repo.fulfilment.deliver(target), fulfilmentOut)
    if (verb === 'cancel') return outcome(() => repo.fulfilment.cancel(target), fulfilmentOut)
    const input = newRefund(body)
    if (typeof input === 'string') return json({ error: input }, 400)
    return outcome(() => repo.refunds.create(target, input), refundOut, 201)
  }

  if (path === '/api/merchant/balance' && method === 'GET') {
    const repo = await merchantRepo(env, request)
    if (repo instanceof Response) return repo
    return json({ balances: (await repo.finance.balance()).map(balanceOut) }, 200, PRIVATE)
  }

  /* ------------------------------------------------------------ platform */

  /* The platform's back office. Every read is audited by the repository
     wrapper, one statement however many merchants it drew on, and carries
     orders, money or personal data, so none of it may be cached. */

  if (path === '/api/platform/orders' && method === 'GET') {
    const repo = await platformRepo(env, request)
    if (repo instanceof Response) return repo
    const filter = orderFilter(url)
    if (typeof filter === 'string') return json({ error: filter }, 400)
    const merchant = url.searchParams.get('merchant') || undefined
    if (merchant && !ID.test(merchant)) return json({ error: 'not a merchant id' }, 400)
    const limit = filter.limit ?? ORDER_PAGE
    const orders = await repo.orders.list({ ...filter, merchant })
    const page = orders.slice(0, limit)
    const last = page[page.length - 1]
    return json(
      {
        from: filter.from ?? null,
        to: filter.to ?? null,
        next: orders.length > limit ? `${last.created_at}|${last.id}` : null,
        orders: page.map(platformOrderSummary),
      },
      200,
      PRIVATE,
    )
  }

  if (path === '/api/platform/merchants/names' && method === 'GET') {
    const repo = await platformRepo(env, request)
    if (repo instanceof Response) return repo
    return json({ merchants: await repo.merchants.names() }, 200, PRIVATE)
  }

  if (path === '/api/platform/payments' && method === 'GET') {
    const repo = await platformRepo(env, request)
    if (repo instanceof Response) return repo
    const filter = paymentFilter(url)
    if (typeof filter === 'string') return json({ error: filter }, 400)
    return json({ from: filter.from, to: filter.to, ...paymentsOut(await repo.payments.list(filter), filter.limit) }, 200, PRIVATE)
  }

  if (path === '/api/platform/reports' && method === 'GET') {
    const repo = await platformRepo(env, request)
    if (repo instanceof Response) return repo
    const range = reportRange(url)
    if (typeof range === 'string') return json({ error: range }, 400)
    const [sales, extra] = await Promise.all([repo.stats.sales(range), repo.analytics.report(range)])
    return json({ ...salesOut(sales), ...reportOut(extra) }, 200, PRIVATE)
  }

  if (path === '/api/platform/customers' && method === 'GET') {
    const repo = await platformRepo(env, request)
    if (repo instanceof Response) return repo
    const q = (url.searchParams.get('q') ?? '').trim()
    if (q.length > 80) return json({ error: 'Search by at most 80 characters.' }, 400)
    const cursor = url.searchParams.get('before')
    const at = cursor === null ? null : cursor.match(CUSTOMER_CURSOR)
    if (cursor !== null && !at) return json({ error: 'before is the next value of the page before.' }, 400)
    const limit = pageSize(url)
    if (typeof limit === 'string') return json({ error: limit }, 400)
    const page = await repo.customers.list({ q: q || undefined, before: at ? { at: at[1], id: at[2] } : undefined, limit })
    const shown = page.customers.slice(0, limit)
    const last = shown[shown.length - 1]
    return json(
      {
        next: page.customers.length > limit ? `${last.created_at}|${last.id}` : null,
        customers: shown.map(customerOut),
        guests: page.guests,
      },
      200,
      PRIVATE,
    )
  }

  const customerId = path.match(CUSTOMER)?.[1]
  if (customerId && method === 'GET') {
    const repo = await platformRepo(env, request)
    if (repo instanceof Response) return repo
    if (!ID.test(customerId)) return json({ error: 'not found' }, 404, PRIVATE)
    const customer = await repo.customers.get(customerId)
    return customer ? json(customerDetailOut(customer), 200, PRIVATE) : json({ error: 'not found' }, 404, PRIVATE)
  }

  const salesFor = path.match(MERCHANT_SALES)?.[1]
  if (salesFor && method === 'GET') {
    const repo = await platformRepo(env, request)
    if (repo instanceof Response) return repo
    const range = reportRange(url)
    if (typeof range === 'string') return json({ error: range }, 400)
    if (!ID.test(salesFor)) return json({ error: 'not found' }, 404)
    const report = await repo.merchants.sales(salesFor, range)
    if (!report) return json({ error: 'not found' }, 404)
    const { merchant_id: _m, ...rest } = report
    return json(salesOut(rest), 200, PRIVATE)
  }

  /* Any order, every merchant's part of it. Audited against each merchant
     whose lines it read, by the repository wrapper. */
  const platformOrder = path.match(PLATFORM_ORDER)?.[1]
  if (platformOrder && method === 'GET') {
    const repo = await platformRepo(env, request)
    if (repo instanceof Response) return repo
    const order = await repo.orders.get(platformOrder)
    return order ? json(orderDetail(order), 200, PRIVATE) : json({ error: 'not found' }, 404)
  }

  const platformRefund = path.match(PLATFORM_REFUND)?.[1]
  if (platformRefund && method === 'POST') {
    const repo = await platformRepo(env, request)
    if (repo instanceof Response) return repo
    const input = newRefund(await readBody(request))
    if (typeof input === 'string') return json({ error: input }, 400)
    return outcome(() => repo.refunds.create(platformRefund, input), refundOut, 201)
  }

  /* One merchant's pending part, cancelled by the platform: for a suspended
     merchant whose own staff can no longer reach the console. */
  const partCancel = path.match(PART_CANCEL)
  if (partCancel && method === 'POST') {
    const repo = await platformRepo(env, request)
    if (repo instanceof Response) return repo
    const [, target, merchantId] = partCancel
    return outcome(() => repo.parts.cancel(target, merchantId), fulfilmentOut)
  }

  const commissionFor = path.match(COMMISSION)?.[1]
  if (commissionFor && method === 'POST') {
    const repo = await platformRepo(env, request)
    if (repo instanceof Response) return repo
    const bps = whole(fields(await readBody(request)).commissionBps)
    if (bps === null || bps > 10_000) return json({ error: 'commissionBps is a whole number from 0 to 10000.' }, 400)
    return outcome(
      () => repo.merchants.setCommission(commissionFor, bps),
      (c) => ({ merchantId: c.merchant_id, commissionBps: c.commission_bps }),
    )
  }

  const payoutFor = path.match(PAYOUTS)?.[1]
  if (payoutFor && method === 'POST') {
    const repo = await platformRepo(env, request)
    if (repo instanceof Response) return repo
    const input = newPayout(await readBody(request))
    if (typeof input === 'string') return json({ error: input }, 400)
    return outcome(() => repo.payouts.create(payoutFor, input), payoutOut, 201)
  }

  if (path === '/api/platform/balances' && method === 'GET') {
    const repo = await platformRepo(env, request)
    if (repo instanceof Response) return repo
    return json({ balances: (await repo.finance.balance()).map(balanceOut) }, 200, PRIVATE)
  }

  if (path === '/api/platform/overview' && method === 'GET') {
    const repo = await platformRepo(env, request)
    if (repo instanceof Response) return repo
    // Ranking and the pending/active/suspended counts are read off the one
    // merchant list rather than asked for again.
    const [overview, merchants, attention] = await Promise.all([
      repo.stats.overview(),
      repo.merchants.list(),
      repo.analytics.attention(),
    ])
    return json(
      { overview: platformOverviewOut(overview), merchants: merchants.map(merchantOut), attention: attentionOut(attention) },
      200,
      PRIVATE,
    )
  }

  if (path === '/api/platform/merchants/all' && method === 'GET') {
    const repo = await platformRepo(env, request)
    if (repo instanceof Response) return repo
    return json({ merchants: (await repo.merchants.list()).map(merchantOut) })
  }

  // After /all and /names, which this pattern would otherwise take for ids.
  const merchantId = path.match(PLATFORM_MERCHANT)?.[1]
  if (merchantId && method === 'GET') {
    const repo = await platformRepo(env, request)
    if (repo instanceof Response) return repo
    if (!ID.test(merchantId)) return json({ error: 'not found' }, 404)
    const detail = await repo.merchants.get(merchantId)
    return detail ? json(merchantDetailOut(detail), 200, PRIVATE) : json({ error: 'not found' }, 404)
  }

  const transition = path.match(TRANSITION)
  if (transition && method === 'POST') {
    const repo = await platformRepo(env, request)
    if (repo instanceof Response) return repo
    const [, merchantId, action] = transition
    try {
      return json(action === 'suspend' ? await repo.merchants.suspend(merchantId) : await repo.merchants.restore(merchantId))
    } catch (err) {
      // Pending, already in the target state, or no such merchant. Approval
      // is the only way out of pending, so this route never is.
      if (/is not (active|suspended)/.test(String(err))) {
        return json(
          { error: action === 'suspend' ? 'Only an active merchant can be suspended.' : 'Only a suspended merchant can be restored.' },
          409,
        )
      }
      throw err
    }
  }

  if (path === '/api/platform/audit' && method === 'GET') {
    const repo = await platformRepo(env, request)
    if (repo instanceof Response) return repo
    const merchantId = url.searchParams.get('merchant') || null
    // A positive whole number of at most 15 digits, so always a safe integer.
    const cursor = url.searchParams.get('before')
    if (cursor !== null && !/^[1-9]\d{0,14}$/.test(cursor)) {
      return json({ error: 'before is the next value of the page before.' }, 400)
    }
    const before = cursor === null ? null : Number(cursor)
    if (merchantId !== null && merchantId.length > 64) return json({ error: 'not a merchant id' }, 400)
    try {
      return json(auditOut(await repo.audit.list({ merchantId, before })))
    } catch (err) {
      if (/does not exist/.test(String(err))) return json({ error: 'No merchant with that id.' }, 404)
      throw err
    }
  }

  const approveId = path.match(APPROVE)?.[1]
  if ((path === '/api/platform/merchants' && method === 'GET') || (approveId && method === 'POST')) {
    const session = await actor(env, request)
    if (session instanceof Response) return session
    // approveMerchant cannot verify its caller; this line is the only thing
    // that stops merchant staff approving their own application.
    if (session.scope !== 'platform') return json({ error: 'not a platform account' }, 403)

    if (approveId) {
      const { slug } = fields(await readBody(request))
      return reply(await approveMerchant(env, session.staffId, approveId, slug))
    }

    // Every platform read of merchant data is audited, same as the write in
    // approveMerchant. merchant_id is NULL because this spans every pending
    // applicant, not one merchant.
    await env.ORDERS.prepare(
      `INSERT INTO audit_log (id, actor_id, actor_scope, merchant_id, action)
       VALUES (?1, ?2, 'platform', NULL, 'merchants.pending.list')`,
    )
      .bind(id('aud'), session.staffId)
      .run()

    const { results } = await env.ORDERS.prepare(
      `SELECT m.id, m.name, m.created_at AS createdAt, s.email
         FROM merchants m JOIN staff s ON s.merchant_id = m.id AND s.role = 'owner'
        WHERE m.status = 'pending'
        ORDER BY m.created_at`,
    ).all<{ id: string; name: string; createdAt: string; email: string }>()
    return json({ merchants: results ?? [] })
  }

  /* Whether the defences are bound, since an absent one allows everything
     silently — and the AI bindings, whose absence only a log line would
     otherwise mention. Presence only. */
  if (path === '/api/health' && method === 'GET') {
    return json({
      ok: true,
      orders: Boolean(env.ORDERS),
      loginRateLimit: Boolean(env.LOGIN_LIMITER),
      signupRateLimit: Boolean(env.SIGNUP_LIMITER),
      durableThrottle: Boolean(env.IP_THROTTLE),
      ai: Boolean(env.AI),
      vectorize: Boolean(env.VECTORIZE),
    })
  }

  return json({ error: 'not found' }, 404)
}

export default {
  async fetch(request: Request, env: ConsoleEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    /*
     * The console is same-origin with its own SPA, so a state-changing request
     * from any other origin is refused. SameSite=Strict does not cover this:
     * the storefront is a sibling subdomain under the same registrable domain,
     * which makes it the same site. Some older browsers send no Origin on a
     * cross-origin form POST, so a missing header is refused rather than
     * trusted — the same fail-closed rule this codebase applies at its other
     * boundaries. This is not a defence against a stolen cookie: only a
     * browser is stopped from forging Origin, and nothing here checks who
     * holds the cookie. That is HttpOnly, short expiry and hashing the token
     * at rest.
     */
    const origin = request.headers.get('origin')
    if (request.method !== 'GET' && origin !== url.origin) {
      return json({ error: 'cross-origin request refused' }, 403)
    }

    let res: Response
    try {
      res = await route(request, env, url, ctx)
    } catch (err) {
      // Logged, not returned: internal detail in an error body is how binding
      // names and stack traces end up in someone else's console.
      console.error('unhandled', err)
      res = json({ error: 'internal error' }, 500)
    }
    // Every merchant and platform answer is private, the refusals too: a 400
    // or 403 cached by something in between would outlive the reason for it,
    // and a route that forgets PRIVATE on one branch is not a leak here.
    if (/^\/api\/(merchant|platform)\//.test(url.pathname)) res.headers.set('cache-control', 'no-store')
    return res
  },
}
