import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import worker from './console'
import { registerMerchant } from './staff-auth'
import { totpCode } from './totp'
import { derive, toB64, KDF_ROUNDS, PBKDF2_ITERATIONS } from './credentials'
import type { RateLimiterBinding } from './auth'
import type { MemoryD1 } from '../test/d1-memory'
import { stubPwned, env, good, activeMerchant, cookieOf } from '../test/staff-fixtures'

beforeEach(stubPwned)
afterEach(() => vi.unstubAllGlobals())

type Extra = { LOGIN_LIMITER?: RateLimiterBinding; SIGNUP_LIMITER?: RateLimiterBinding }

function call(
  db: D1Database,
  method: string,
  path: string,
  opts: {
    cookie?: string
    body?: unknown
    headers?: Record<string, string>
    extra?: Extra
    noOrigin?: boolean
  } = {},
) {
  const headers: Record<string, string> = { ...opts.headers }
  if (opts.cookie) headers.Cookie = opts.cookie
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  // Every other test wants the console's own writes to work; a request that
  // means to test the origin check itself opts out with noOrigin.
  if (method !== 'GET' && !opts.noOrigin && !headers.Origin) headers.Origin = 'https://console.test'
  return worker.fetch(
    new Request(`https://console.test${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
    { ...env(db), ...opts.extra },
  )
}

/** Password only: the cookie a sign-in sets, before any second factor. */
async function signInOver(db: D1Database, email: string, password: string): Promise<string> {
  const res = await call(db, 'POST', '/api/staff/signin', { body: { email, password } })
  expect(res.status).toBe(200)
  return cookieOf(res.headers.get('set-cookie'))
}

/** Through the TOTP routes, the way the console will drive them. */
async function enrol(db: D1Database, cookie: string): Promise<void> {
  const begun = await call(db, 'POST', '/api/staff/totp/begin', { cookie })
  expect(begun.status).toBe(200)
  const { secret } = (await begun.json()) as { secret: string }
  const confirmed = await call(db, 'POST', '/api/staff/totp/confirm', {
    cookie,
    body: { code: await totpCode(secret) },
  })
  expect(confirmed.status).toBe(200)
}

async function enrollingSession() {
  const mem = await activeMerchant()
  return { ...mem, cookie: await signInOver(mem.db, good.email, good.password) }
}

async function activeSession() {
  const s = await enrollingSession()
  await enrol(s.db, s.cookie)
  return s
}

const ADMIN = { email: 'admin@nexus.test', password: 'platform-admin-passphrase' }

/** A platform admin, signed in past the second factor, in a database of its own. */
async function platformSession(mem: MemoryD1) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const hash = await derive(ADMIN.password, salt, KDF_ROUNDS)
  mem.raw
    .prepare(
      `INSERT INTO staff (id, email, scope, merchant_id, role, password_hash, password_salt, iterations, kdf_rounds)
       VALUES ('stf_admin', ?, 'platform', NULL, 'admin', ?, ?, ?, ?)`,
    )
    .run(ADMIN.email, toB64(hash), toB64(salt), PBKDF2_ITERATIONS, KDF_ROUNDS)
  const cookie = await signInOver(mem.db, ADMIN.email, ADMIN.password)
  await enrol(mem.db, cookie)
  return cookie
}

function seedProduct(raw: MemoryD1['raw'], merchantId: string, productId: string) {
  raw
    .prepare(
      `INSERT OR IGNORE INTO merchants (id, slug, name, settlement_currency, status)
       VALUES (?, ?, 'Other', 'USD', 'active')`,
    )
    .run(merchantId, `slug-${merchantId}`)
  raw
    .prepare(
      `INSERT INTO products (id, merchant_id, sku, title, brand, category, price_minor, currency, status)
       VALUES (?, ?, ?, ?, 'B', 'C', 1000, 'USD', 'draft')`,
    )
    .run(productId, merchantId, `sku-${productId}`, productId)
}

/** What the storefront needs before it can render a card. The console cannot set it yet. */
function withPhotos(raw: MemoryD1['raw'], productId: string) {
  raw
    .prepare(`UPDATE products SET media = ? WHERE id = ?`)
    .run(JSON.stringify({ heroImage: '/h.jpg', thumb: '/t.jpg', gallery: ['/g.jpg'] }), productId)
}

/** A second, pending application, which is what the approve route exists for. */
async function pendingApplication(mem: MemoryD1): Promise<string> {
  await registerMerchant(env(mem.db), { ...good, email: 'applicant@example.com', name: 'Pending Co' })
  return (mem.raw.prepare(`SELECT id FROM merchants WHERE status = 'pending'`).get() as { id: string }).id
}

const MERCHANT_ROUTES = [
  ['GET', '/api/merchant/products'],
  ['POST', '/api/merchant/products'],
  ['PATCH', '/api/merchant/products/p1'],
] as const

const PLATFORM_ROUTES = [
  ['GET', '/api/platform/merchants'],
  ['POST', '/api/platform/merchants/mch_x/approve'],
] as const

describe('the console worker: who may reach what', () => {
  it('refuses every merchant and platform route without a session', async () => {
    const { db } = await activeMerchant()
    for (const [method, path] of [...MERCHANT_ROUTES, ...PLATFORM_ROUTES]) {
      const res = await call(db, method, path, { body: method === 'GET' ? undefined : {} })
      expect(res.status, `${method} ${path}`).toBe(401)
    }
  })

  it('refuses every merchant and platform route with an enrolling session', async () => {
    // The gate is the point: a password alone reaches nothing.
    const { db, cookie } = await enrollingSession()
    for (const [method, path] of [...MERCHANT_ROUTES, ...PLATFORM_ROUTES]) {
      const res = await call(db, method, path, { cookie, body: method === 'GET' ? undefined : {} })
      expect(res.status, `${method} ${path}`).toBe(403)
      // Said as such, so the console can send them to the code prompt rather
      // than read it as the wrong kind of account.
      expect(await res.json()).toEqual({ error: 'second factor required' })
    }
  })

  it('refuses the TOTP routes to a session that has already passed them', async () => {
    const { db, cookie } = await activeSession()
    for (const path of ['/api/staff/totp/begin', '/api/staff/totp/confirm']) {
      const res = await call(db, 'POST', path, { cookie, body: { code: '000000' } })
      expect(res.status, path).toBe(403)
    }
  })

  it('refuses a platform route to merchant staff', async () => {
    const { db, cookie } = await activeSession()
    const res = await call(db, 'GET', '/api/platform/merchants', { cookie })
    expect(res.status).toBe(403)
  })

  it('refuses approval to merchant staff, so nobody approves their own application', async () => {
    // approveMerchant trusts its staffId; the route is the only thing that
    // can know the caller is platform staff.
    const mem = await activeSession()
    const pending = await pendingApplication(mem)
    const res = await call(mem.db, 'POST', `/api/platform/merchants/${pending}/approve`, {
      cookie: mem.cookie,
      body: { slug: 'mine-now' },
    })
    expect(res.status).toBe(403)
    expect(mem.raw.prepare(`SELECT status FROM merchants WHERE id = ?`).get(pending)).toEqual({
      status: 'pending',
    })
  })

  it("refuses a suspended merchant's live session with 403, not 500", async () => {
    const { db, raw, cookie, merchantId } = await activeSession()
    raw.prepare(`UPDATE merchants SET status = 'suspended' WHERE id = ?`).run(merchantId)
    const res = await call(db, 'GET', '/api/merchant/products', { cookie })
    expect(res.status).toBe(403)
  })

  it('refuses a state-changing request from another origin', async () => {
    // SameSite=Strict does not help against a sibling subdomain: the storefront
    // and the console share a registrable domain, so they are the same site.
    const { db, cookie } = await activeSession()
    const res = await call(db, 'POST', '/api/merchant/products', {
      cookie,
      headers: { Origin: 'https://nexus-tech-collective.example' },
      body: { sku: 'S1', title: 'T', brand: 'B', category: 'phones', priceMinor: 1000 },
    })
    expect(res.status).toBe(403)
  })

  it('refuses a state-changing request with no Origin header', async () => {
    // Some older browsers send no Origin on a cross-origin form POST; a
    // request whose origin cannot be verified is refused, not trusted.
    const { db, cookie } = await activeSession()
    const res = await call(db, 'POST', '/api/merchant/products', {
      cookie,
      noOrigin: true,
      body: { sku: 'S1', title: 'T', brand: 'B', category: 'phones', priceMinor: 1000 },
    })
    expect(res.status).toBe(403)
  })

  it('accepts a state-changing request whose Origin matches the console', async () => {
    // A same-origin fetch from a modern browser sends Origin equal to the
    // page's own origin.
    const { db, cookie } = await activeSession()
    const res = await call(db, 'POST', '/api/merchant/products', {
      cookie,
      headers: { Origin: 'https://console.test' },
      body: { sku: 'S1', title: 'T', brand: 'B', category: 'phones', priceMinor: 1000 },
    })
    expect(res.status).toBe(201)
  })
})

describe('the console worker: merchant products', () => {
  it("lists only the signed-in merchant's products", async () => {
    const { db, raw, cookie, merchantId } = await activeSession()
    seedProduct(raw, merchantId, 'mine')
    seedProduct(raw, 'mch_other', 'LEAK')
    const res = await call(db, 'GET', '/api/merchant/products', { cookie })
    expect(res.status).toBe(200)
    const text = JSON.stringify(await res.json())
    expect(text).toContain('mine')
    expect(text).not.toContain('LEAK')
  })

  it("creates a product under the session's merchant, whatever the body says", async () => {
    const { db, cookie, merchantId } = await activeSession()
    const res = await call(db, 'POST', '/api/merchant/products', {
      cookie,
      // merchantId in the body is ignored because the type has no such field.
      body: { merchantId: 'mch_other', sku: 'S1', title: 'T', brand: 'B', category: 'phones', priceMinor: 1000 },
    })
    expect(res.status).toBe(201)
    const row = (await res.json()) as { merchantId: string }
    expect(row.merchantId).toBe(merchantId)
  })

  it('refuses a malformed product with 400 rather than a database error', async () => {
    const { db, cookie } = await activeSession()
    for (const body of [
      { sku: 'S1', title: 'T', brand: 'B', category: 'phones', priceMinor: 10.5 },
      { sku: 'S1', title: 'T', brand: 'B', category: 'phones', priceMinor: -1 },
      { title: 'T', brand: 'B', category: 'phones', priceMinor: 1 },
    ]) {
      const res = await call(db, 'POST', '/api/merchant/products', { cookie, body })
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
  })

  it("refuses to patch another merchant's product with 404, not 403", async () => {
    const { db, raw, cookie } = await activeSession()
    seedProduct(raw, 'mch_other', 'theirs')
    const res = await call(db, 'PATCH', '/api/merchant/products/theirs', {
      cookie,
      body: { priceMinor: 1 },
    })
    expect(res.status).toBe(404)
    expect(raw.prepare(`SELECT price_minor FROM products WHERE id = 'theirs'`).get()).toEqual({
      price_minor: 1000,
    })
  })

  it('patches its own product, and cannot write rating or review_count', async () => {
    const { db, raw, cookie, merchantId } = await activeSession()
    seedProduct(raw, merchantId, 'mine')
    withPhotos(raw, 'mine')
    const res = await call(db, 'PATCH', '/api/merchant/products/mine', {
      cookie,
      body: { priceMinor: 2500, status: 'published', rating: 5, review_count: 999, reviewCount: 999 },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ priceMinor: 2500, status: 'published' })
    expect(
      raw.prepare(`SELECT price_minor, status, rating, review_count FROM products WHERE id = 'mine'`).get(),
    ).toEqual({ price_minor: 2500, status: 'published', rating: 0, review_count: 0 })
  })
})

describe('the console worker: what may go on sale', () => {
  it('refuses to publish a product with no photos, which the storefront cannot render', async () => {
    const { db, raw, cookie, merchantId } = await activeSession()
    seedProduct(raw, merchantId, 'bare')
    const res = await call(db, 'PATCH', '/api/merchant/products/bare', { cookie, body: { status: 'published' } })
    expect(res.status).toBe(409)
    expect(raw.prepare(`SELECT status FROM products WHERE id = 'bare'`).get()).toEqual({ status: 'draft' })
  })

  it('refuses a free product on sale, whether publishing it or repricing it once live', async () => {
    const { db, raw, cookie, merchantId } = await activeSession()
    seedProduct(raw, merchantId, 'mine')
    withPhotos(raw, 'mine')
    const publishFree = await call(db, 'PATCH', '/api/merchant/products/mine', {
      cookie,
      body: { status: 'published', priceMinor: 0 },
    })
    expect(publishFree.status).toBe(409)

    raw.prepare(`UPDATE products SET status = 'published' WHERE id = 'mine'`).run()
    const dropToZero = await call(db, 'PATCH', '/api/merchant/products/mine', { cookie, body: { priceMinor: 0 } })
    expect(dropToZero.status).toBe(409)
    expect(raw.prepare(`SELECT price_minor FROM products WHERE id = 'mine'`).get()).toEqual({ price_minor: 1000 })
  })

  it('refuses a category the storefront does not have', async () => {
    const { db, cookie } = await activeSession()
    const res = await call(db, 'POST', '/api/merchant/products', {
      cookie,
      body: { sku: 'S1', title: 'T', brand: 'B', category: 'Phones', priceMinor: 100 },
    })
    expect(res.status).toBe(400)
  })

  it('refuses an empty patch rather than auditing a write that changed nothing', async () => {
    const { db, raw, cookie, merchantId } = await activeSession()
    seedProduct(raw, merchantId, 'mine')
    const before = raw.prepare(`SELECT COUNT(*) AS n FROM audit_log`).get()
    const res = await call(db, 'PATCH', '/api/merchant/products/mine', { cookie, body: {} })
    expect(res.status).toBe(400)
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM audit_log`).get()).toEqual(before)
  })
})

describe('the console worker: platform', () => {
  it('lists pending applications and approves one at the address the platform chooses', async () => {
    const mem = await activeMerchant()
    const pending = await pendingApplication(mem)
    const cookie = await platformSession(mem)

    const list = await call(mem.db, 'GET', '/api/platform/merchants', { cookie })
    expect(list.status).toBe(200)
    const { merchants } = (await list.json()) as { merchants: { id: string; email: string }[] }
    expect(merchants).toEqual([expect.objectContaining({ id: pending, email: 'applicant@example.com' })])

    const res = await call(mem.db, 'POST', `/api/platform/merchants/${pending}/approve`, {
      cookie,
      body: { slug: 'pending-co' },
    })
    expect(res.status).toBe(200)
    expect(mem.raw.prepare(`SELECT status, slug FROM merchants WHERE id = ?`).get(pending)).toEqual({
      status: 'active',
      slug: 'pending-co',
    })
  })

  it('audits a platform read of pending applications', async () => {
    const mem = await activeMerchant()
    await pendingApplication(mem)
    const cookie = await platformSession(mem)

    const res = await call(mem.db, 'GET', '/api/platform/merchants', { cookie })
    expect(res.status).toBe(200)

    expect(
      mem.raw
        .prepare(
          `SELECT actor_id, actor_scope, merchant_id, action FROM audit_log
            WHERE action = 'merchants.pending.list'`,
        )
        .get(),
    ).toEqual({ actor_id: 'stf_admin', actor_scope: 'platform', merchant_id: null, action: 'merchants.pending.list' })
  })
})

describe('the console worker: staff authentication', () => {
  it('answers /me without a session as an answer, not an error', async () => {
    const { db } = await activeMerchant()
    const res = await call(db, 'GET', '/api/staff/me')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ kind: null })
  })

  it('tells an enrolling session nothing about the merchant', async () => {
    const { db, cookie } = await enrollingSession()
    const res = await call(db, 'GET', '/api/staff/me', { cookie })
    expect(await res.json()).toEqual({ kind: 'enrolling' })
  })

  it('greets an active merchant session with its merchant', async () => {
    const { db, cookie } = await activeSession()
    const res = await call(db, 'GET', '/api/staff/me', { cookie })
    expect(await res.json()).toEqual({
      kind: 'active',
      scope: 'merchant',
      merchant: { name: good.name, slug: 'acme', status: 'active' },
    })
  })

  it('registers an application through the route', async () => {
    const { db, raw } = await activeMerchant()
    const res = await call(db, 'POST', '/api/staff/register', {
      body: { name: 'New Co', email: 'new@example.com', password: good.password },
    })
    expect(res.status).toBe(202)
    expect(raw.prepare(`SELECT status FROM merchants WHERE name = 'New Co'`).get()).toEqual({
      status: 'pending',
    })
  })

  it('signs out by deleting the session row, not only the cookie', async () => {
    const { db, raw, cookie } = await activeSession()
    const res = await call(db, 'POST', '/api/staff/signout', { cookie })
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=0/)
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM staff_sessions`).get()).toEqual({ n: 0 })
    expect(await (await call(db, 'GET', '/api/staff/me', { cookie })).json()).toEqual({ kind: null })
  })

  it('throttles sign-in and registration per IP before any work is done', async () => {
    const { db, raw } = await activeMerchant()
    const refuse: RateLimiterBinding = { limit: async () => ({ success: false }) }
    const extra = { LOGIN_LIMITER: refuse, SIGNUP_LIMITER: refuse }

    const signin = await call(db, 'POST', '/api/staff/signin', {
      extra,
      body: { email: good.email, password: 'wrong-but-long-enough' },
    })
    expect(signin.status).toBe(429)
    expect(signin.headers.get('retry-after')).toBeTruthy()
    // Refused before the password was checked, so it cost the account nothing.
    expect(raw.prepare(`SELECT failed_attempts FROM staff`).get()).toEqual({ failed_attempts: 0 })

    const register = await call(db, 'POST', '/api/staff/register', {
      extra,
      body: { name: 'New Co', email: 'new@example.com', password: good.password },
    })
    expect(register.status).toBe(429)
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM merchants`).get()).toEqual({ n: 1 })
  })
})
