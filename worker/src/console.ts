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
import { scopedTo, type NewProduct, type ProductPatch, type ProductRow, type Repository } from './tenancy'
import { guard, type IpDefences } from './auth'

/*
 * Re-exported because Cloudflare resolves a Durable Object class by name from
 * the worker's own module exports. This worker hosts its own IpThrottle
 * namespace rather than binding nexus-api's, so each deploys without the other.
 */
export { IpThrottle } from './throttle'

export interface ConsoleEnv extends StaffEnv, IpDefences {}

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

/* ------------------------------------------------------------- products io */

const text = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : null

/** A whole, non-negative number: what price_minor and stock_count accept. */
const whole = (v: unknown): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null

const STATUSES = new Set(['draft', 'published', 'archived'])

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
  return patch
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
})

/* ------------------------------------------------------------------ routes */

const PRODUCT = /^\/api\/merchant\/products\/([^/]+)$/
const APPROVE = /^\/api\/platform\/merchants\/([^/]+)\/approve$/

async function route(request: Request, env: ConsoleEnv, url: URL): Promise<Response> {
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
    const row = await repo.products.update(productId, patch)
    return row ? json(product(row)) : json({ error: 'not found' }, 404)
  }

  /* ------------------------------------------------------------ platform */

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

    // ponytail: the merchants table is outside the Repository, as it is for
    // approveMerchant, so this read is not audited. Add a platform audit row
    // here if reading applications ever needs to be on the record.
    const { results } = await env.ORDERS.prepare(
      `SELECT m.id, m.name, m.created_at AS createdAt, s.email
         FROM merchants m JOIN staff s ON s.merchant_id = m.id AND s.role = 'owner'
        WHERE m.status = 'pending'
        ORDER BY m.created_at`,
    ).all<{ id: string; name: string; createdAt: string; email: string }>()
    return json({ merchants: results ?? [] })
  }

  /* Whether the defences are bound, since an absent one allows everything
     silently. Presence only. */
  if (path === '/api/health' && method === 'GET') {
    return json({
      ok: true,
      orders: Boolean(env.ORDERS),
      loginRateLimit: Boolean(env.LOGIN_LIMITER),
      signupRateLimit: Boolean(env.SIGNUP_LIMITER),
      durableThrottle: Boolean(env.IP_THROTTLE),
    })
  }

  return json({ error: 'not found' }, 404)
}

export default {
  async fetch(request: Request, env: ConsoleEnv): Promise<Response> {
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
      return await route(request, env, url)
    } catch (err) {
      // Logged, not returned: internal detail in an error body is how binding
      // names and stack traces end up in someone else's console.
      console.error('unhandled', err)
      return json({ error: 'internal error' }, 500)
    }
  },
}
