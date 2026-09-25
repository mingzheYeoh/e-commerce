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
  ORDER_CAP,
  scopedTo,
  platformWide,
  utcDay,
  type AuditPage,
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

/** Orders carry a name and a delivery address: no shared cache may keep them. */
const PRIVATE = { 'cache-control': 'no-store' }

const orderSummary = (o: OrderSummary) => ({
  id: o.id,
  placedAt: o.created_at,
  method: o.method,
  status: o.payment_status,
  items: o.items,
  totals: o.totals,
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
    sku: l.sku,
    title: l.title,
    finish: l.variant || null,
    qty: l.qty,
    unitMinor: l.unit_price_cents,
    currency: l.currency,
  })),
  totals: o.totals,
})

const overviewOut = (o: Overview) => ({
  ...o,
  top: o.top.map((t) => ({ productId: t.product_id, title: t.title, currency: t.currency, minor: t.minor, qty: t.qty })),
  lowStock: o.lowStock.map((p) => ({ id: p.id, title: p.title, stockCount: p.stock_count })),
})

/** The platform page shows neither top products nor low stock, so neither is sent. */
const platformOverviewOut = ({ revenue, orders, trend, products }: Overview) => ({ revenue, orders, trend, products })

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
const TRANSITION = /^\/api\/platform\/merchants\/([^/]+)\/(suspend|restore)$/

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
    const range = orderRange(url)
    if (typeof range === 'string') return json({ error: range }, 400)
    const orders = await repo.orders.list(range)
    // The repository returns one past the cap exactly so this can be said
    // rather than a partial list passing for the whole range.
    return json(
      { ...range, truncated: orders.length > ORDER_CAP, orders: orders.slice(0, ORDER_CAP).map(orderSummary) },
      200,
      PRIVATE,
    )
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

  /* ------------------------------------------------------------ platform */

  if (path === '/api/platform/overview' && method === 'GET') {
    const repo = await platformRepo(env, request)
    if (repo instanceof Response) return repo
    // Ranking and the pending/active/suspended counts are read off the one
    // merchant list rather than asked for again.
    const [overview, merchants] = await Promise.all([repo.stats.overview(), repo.merchants.list()])
    return json({ overview: platformOverviewOut(overview), merchants: merchants.map(merchantOut) })
  }

  if (path === '/api/platform/merchants/all' && method === 'GET') {
    const repo = await platformRepo(env, request)
    if (repo instanceof Response) return repo
    return json({ merchants: (await repo.merchants.list()).map(merchantOut) })
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

    try {
      return await route(request, env, url, ctx)
    } catch (err) {
      // Logged, not returned: internal detail in an error body is how binding
      // names and stack traces end up in someone else's console.
      console.error('unhandled', err)
      return json({ error: 'internal error' }, 500)
    }
  },
}
