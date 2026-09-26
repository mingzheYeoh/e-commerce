// @vitest-environment node
// Node, not the repo-wide jsdom: jsdom's FormData and File cannot be read by
// the Request a worker receives, so an upload would hang.
import { describe, it, expect, beforeEach } from 'vitest'
import worker, { type Env } from './index'
import { memoryD1, type MemoryD1 } from '../test/d1-memory'
import { memoryR2, webpBytes, type MemoryR2 } from '../test/r2-memory'
import { derive, sha256, toB64 } from './credentials'
import { readFileSync } from 'node:fs'

const BASE = 'https://api.test/media/u/'
const ORIGIN = 'http://localhost:5173'

let mem: MemoryD1
let media: MemoryR2
let priv: MemoryR2

/**
 * One merchant with two products, two shoppers with a session each. Ada's
 * order NX-AAAAA holds prd_1; its part is delivered only when a test says so.
 */
beforeEach(async () => {
  mem = memoryD1()
  media = memoryR2()
  priv = memoryR2()
  const { raw } = mem
  raw.prepare(`INSERT INTO merchants (id, slug, name, settlement_currency, status) VALUES ('mch_a', 'a', 'Acme', 'USD', 'active')`).run()
  for (const p of ['prd_1', 'prd_2']) {
    raw
      .prepare(
        `INSERT INTO products (id, merchant_id, sku, title, brand, category, price_minor, currency, status)
         VALUES (?, 'mch_a', ?, ?, 'B', 'audio', 1000, 'USD', 'published')`,
      )
      .run(p, `sku-${p}`, `Title ${p}`)
  }
  for (const [uid, email, name] of [
    ['usr_ada', 'ada@example.com', 'Ada Lovelace'],
    ['usr_bob', 'bob@example.com', 'Bob'],
  ]) {
    raw.prepare(`INSERT INTO users (id, email, name, password_hash, password_salt, iterations) VALUES (?, ?, ?, 'h', 's', 1)`).run(uid, email, name)
    raw
      .prepare(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, '2999-01-01T00:00:00Z')`)
      .run(await sha256(`tok-${uid}`), uid)
  }
  raw
    .prepare(
      `INSERT INTO orders (id, email, ship_name, ship_phone, ship_line1, ship_city, ship_state, ship_postal,
                           method, subtotal_cents, shipping_cents, tax_cents, total_cents, payment_status, user_id)
       VALUES ('NX-AAAAA', 'ada@example.com', 'Ada Lovelace', '1', '1 Road', 'Town', 'OR', '97201',
               'standard', 1000, 0, 0, 1000, 'succeeded', 'usr_ada')`,
    )
    .run()
  raw
    .prepare(
      `INSERT INTO order_lines (order_id, product_id, merchant_id, sku, title, qty, unit_price_cents)
       VALUES ('NX-AAAAA', 'prd_1', 'mch_a', 'sku-prd_1', 'Title prd_1', 1, 1000)`,
    )
    .run()
  raw.prepare(`INSERT INTO order_fulfilments (order_id, merchant_id, stock_taken) VALUES ('NX-AAAAA', 'mch_a', 1)`).run()
})

/** Ada's part delivered `ago` (an SQLite date modifier) ago. */
const deliver = (ago = '-1 days') =>
  mem.raw
    .prepare(
      `UPDATE order_fulfilments SET status = 'delivered', carrier = 'UPS', tracking = '1Z',
              shipped_at = datetime('now', ?), delivered_at = datetime('now', ?)`,
    )
    .run(ago, ago)

async function call(
  method: string,
  path: string,
  opts: { as?: 'usr_ada' | 'usr_bob'; body?: unknown; form?: FormData } = {},
) {
  const headers: Record<string, string> = { origin: ORIGIN }
  let body: BodyInit | undefined
  if (opts.form) {
    // As a browser sends it: multipart with a boundary and a length.
    const encoded = new Response(opts.form)
    body = await encoded.arrayBuffer()
    headers['content-type'] = encoded.headers.get('content-type')!
    headers['content-length'] = String((body as ArrayBuffer).byteLength)
  } else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }
  if (opts.as) headers.cookie = `nexus_session=tok-${opts.as}`
  const res = await worker.fetch(new Request(`https://api.test${path}`, { method, headers, body }), {
    ORDERS: mem.db,
    MEDIA: media.bucket,
    PRIVATE: priv.bucket,
    MEDIA_BASE: BASE,
    ALLOWED_ORIGIN: ORIGIN,
  } as Env)
  return res
}
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, any> })

const one = (field: string, bytes: Uint8Array) => {
  const form = new FormData()
  form.append(field, new File([bytes], 'p.webp', { type: 'image/webp' }))
  return form
}
const pair = () => {
  const form = new FormData()
  form.append('large', new File([webpBytes()], 'l.webp', { type: 'image/webp' }))
  form.append('thumb', new File([webpBytes()], 't.webp', { type: 'image/webp' }))
  return form
}

describe('the deployment config', () => {
  // Bindings are not inherited by a wrangler environment, and an omitted one
  // deploys silently: so each half of each file is checked on its own.
  const halves = (file: string) => {
    const s = readFileSync(`worker/${file}`, 'utf8').replace(/\r\n/g, '\n')
    const at = s.indexOf('[env.staging]')
    return { production: s.slice(0, at), staging: s.slice(at) }
  }
  const privateBucket = (toml: string) => toml.match(/binding = "PRIVATE"\nbucket_name = "([^"]+)"/)?.[1]
  const mediaBase = (toml: string) => toml.match(/^MEDIA_BASE = "([^"]+)"/m)?.[1]

  it('binds the private bucket in both workers, per environment', () => {
    for (const file of ['wrangler.toml', 'wrangler.console.toml']) {
      const { production, staging } = halves(file)
      expect(privateBucket(production), file).toBe('nexus-private')
      expect(privateBucket(staging), file).toBe('nexus-private-staging')
    }
  })

  it("gives nexus-api the console's MEDIA_BASE, per environment", () => {
    const api = halves('wrangler.toml')
    const consoleToml = halves('wrangler.console.toml')
    expect(mediaBase(api.production)).toBe(mediaBase(consoleToml.production))
    expect(mediaBase(api.staging)).toBe(mediaBase(consoleToml.staging))
    expect(mediaBase(api.staging)).toMatch(/staging/)
  })
})

describe('avatars', () => {
  it('replaces the old avatar, deletes its object, and shows the new one on /api/auth/me', async () => {
    const first = await read(await call('POST', '/api/account/avatar', { as: 'usr_ada', form: one('photo', webpBytes()) }))
    expect(first.status).toBe(200)
    expect(first.body.avatarUrl).toMatch(/^https:\/\/api\.test\/media\/u\/avatars\/usr_ada\/ph_[a-z0-9]+\.webp$/)
    const second = await read(await call('POST', '/api/account/avatar', { as: 'usr_ada', form: one('photo', webpBytes()) }))
    expect([...media.objects.keys()]).toEqual([second.body.avatarUrl.slice(BASE.length)])
    const me = await read(await call('GET', '/api/auth/me', { as: 'usr_ada' }))
    expect(me.body.user).toMatchObject({ id: 'usr_ada', avatarUrl: second.body.avatarUrl })
    // Served by the public route, like a product photo.
    expect((await call('GET', new URL(second.body.avatarUrl).pathname)).status).toBe(200)
  })

  it('removes the avatar and its object', async () => {
    await call('POST', '/api/account/avatar', { as: 'usr_ada', form: one('photo', webpBytes()) })
    const res = await read(await call('DELETE', '/api/account/avatar', { as: 'usr_ada' }))
    expect(res).toEqual({ status: 200, body: { avatarUrl: null } })
    expect(media.objects.size).toBe(0)
    expect((await read(await call('GET', '/api/auth/me', { as: 'usr_ada' }))).body.user.avatarUrl).toBeNull()
  })

  it('refuses a signed-out upload, anything but webp, and anything over 100 KB', async () => {
    expect((await call('POST', '/api/account/avatar', { form: one('photo', webpBytes()) })).status).toBe(401)
    expect((await call('POST', '/api/account/avatar', { as: 'usr_ada', form: one('photo', new Uint8Array(20)) })).status).toBe(415)
    expect((await call('POST', '/api/account/avatar', { as: 'usr_ada', form: one('photo', webpBytes(100_000)) })).status).toBe(413)
    expect(media.objects.size).toBe(0)
  })
})

describe('reviews', () => {
  const save = (body: unknown, as: 'usr_ada' | 'usr_bob' = 'usr_ada') => call('POST', '/api/products/prd_1/review', { as, body })

  it('lets only an account whose order of the product was delivered write one', async () => {
    expect((await save({ rating: 5, body: 'Great' })).status).toBe(403)
    deliver()
    expect((await save({ rating: 5, body: 'Great' }, 'usr_bob')).status).toBe(403)
    expect((await call('POST', '/api/products/prd_1/review', { body: { rating: 5 } })).status).toBe(401)
    const saved = await read(await save({ rating: 5, body: '  Great\n\nsound [really]  ' }))
    expect(saved.status).toBe(200)
    // Cleaned the way merchant text is.
    expect(saved.body).toMatchObject({ rating: 5, body: 'Great sound (really)', author: 'Ada L.' })
  })

  it('keeps one review per account and product: a second save edits it', async () => {
    deliver()
    await save({ rating: 5, body: 'Great' })
    await save({ rating: 3, body: 'Actually fine' })
    expect(mem.rows('reviews').map((r) => [r.rating, r.body])).toEqual([[3, 'Actually fine']])
  })

  it('refuses a rating outside 1 to 5 and text over 1000 characters', async () => {
    deliver()
    expect((await save({ rating: 0 })).status).toBe(400)
    expect((await save({ rating: 4.5 })).status).toBe(400)
    expect((await save({ rating: 4, body: 'x'.repeat(1001) })).status).toBe(400)
    expect(mem.rows('reviews')).toEqual([])
  })

  it('lists visible reviews newest first with the average, and tells the viewer what they may do', async () => {
    deliver()
    await save({ rating: 4, body: 'Good' })
    mem.raw
      .prepare(`INSERT INTO reviews (id, user_id, product_id, merchant_id, rating, body, hidden) VALUES ('rev_hidden', 'usr_bob', 'prd_1', 'mch_a', 1, 'Spam', 1)`)
      .run()
    const anon = await read(await call('GET', '/api/products/prd_1/reviews'))
    expect(anon.body).toMatchObject({ average: 4, count: 1, next: null, viewer: null })
    expect(anon.body.reviews).toHaveLength(1)
    expect(anon.body.reviews[0]).toMatchObject({ author: 'Ada L.', rating: 4, body: 'Good', photos: [] })
    expect(JSON.stringify(anon.body)).not.toMatch(/Spam|ada@example|Lovelace|usr_ada/)
    const mine = await read(await call('GET', '/api/products/prd_1/reviews', { as: 'usr_ada' }))
    expect(mine.body.viewer).toMatchObject({ eligible: true, review: { rating: 4, hidden: false } })
    const bob = await read(await call('GET', '/api/products/prd_1/reviews', { as: 'usr_bob' }))
    expect(bob.body.viewer).toMatchObject({ eligible: false, review: { body: 'Spam', hidden: true } })
  })

  it('takes up to three photos, served publicly, and deletes them with the review', async () => {
    deliver()
    expect((await call('POST', '/api/products/prd_1/review/photos', { as: 'usr_ada', form: pair() })).status).toBe(404)
    await save({ rating: 5 })
    for (let i = 0; i < 3; i++) {
      expect((await call('POST', '/api/products/prd_1/review/photos', { as: 'usr_ada', form: pair() })).status).toBe(201)
    }
    expect((await call('POST', '/api/products/prd_1/review/photos', { as: 'usr_ada', form: pair() })).status).toBe(409)
    expect(media.objects.size).toBe(6)
    const list = await read(await call('GET', '/api/products/prd_1/reviews'))
    const photo = list.body.reviews[0].photos[0]
    expect(photo.large).toMatch(/\/media\/u\/reviews\/rev_[a-z0-9]+\/ph_[a-z0-9]+-1600\.webp$/)
    expect((await call('GET', new URL(photo.thumb).pathname)).status).toBe(200)

    const name = photo.large.match(/(ph_[a-z0-9]+)-1600/)[1]
    expect((await call('DELETE', `/api/products/prd_1/review/photos/${name}`, { as: 'usr_ada' })).status).toBe(200)
    expect(media.objects.size).toBe(4)
    expect((await call('DELETE', '/api/products/prd_1/review', { as: 'usr_ada' })).status).toBe(200)
    expect(media.objects.size).toBe(0)
    expect(mem.rows('reviews')).toEqual([])
  })

  it('takes the account’s avatar and review photos out of storage when the account is closed', async () => {
    deliver()
    await save({ rating: 5 })
    await call('POST', '/api/products/prd_1/review/photos', { as: 'usr_ada', form: pair() })
    await call('POST', '/api/account/avatar', { as: 'usr_ada', form: one('photo', webpBytes()) })
    expect(media.objects.size).toBe(3)
    const salt = crypto.getRandomValues(new Uint8Array(16))
    mem.raw
      .prepare(`UPDATE users SET password_hash = ?, password_salt = ?, kdf_rounds = 1 WHERE id = 'usr_ada'`)
      .run(toB64(await derive('right-password', salt, 1)), toB64(salt))
    // The password check itself is auth.ts's; a wrong one closes nothing and deletes nothing.
    expect((await call('POST', '/api/account/delete', { as: 'usr_ada', body: { password: 'wrong' } })).status).toBe(401)
    expect(media.objects.size).toBe(3)
    expect((await call('POST', '/api/account/delete', { as: 'usr_ada', body: { password: 'right-password' } })).status).toBe(200)
    expect(media.objects.size).toBe(0)
    expect(mem.rows('reviews')).toEqual([])
  })
})

describe('return requests', () => {
  const open = (body: unknown, as: 'usr_ada' | 'usr_bob' = 'usr_ada') =>
    call('POST', '/api/account/orders/NX-AAAAA/returns', { as, body })

  it('is refused before delivery, after 30 days, and on someone else’s order', async () => {
    expect((await open({ merchantId: 'mch_a', reason: 'damaged' })).status).toBe(409)
    deliver('-31 days')
    expect((await open({ merchantId: 'mch_a', reason: 'damaged' })).status).toBe(409)
    deliver('-29 days')
    expect((await open({ merchantId: 'mch_a', reason: 'damaged' }, 'usr_bob')).status).toBe(404)
    expect((await open({ merchantId: 'mch_a', reason: 'bored' })).status).toBe(400)
    expect(mem.rows('return_requests')).toEqual([])
  })

  it('files one open request per part, and shows it on the order', async () => {
    deliver()
    const filed = await read(await open({ merchantId: 'mch_a', reason: 'damaged', note: 'Cracked\nscreen' }))
    expect(filed.status).toBe(201)
    expect(filed.body).toMatchObject({ reason: 'damaged', note: 'Cracked screen', status: 'open' })
    expect((await open({ merchantId: 'mch_a', reason: 'other' })).status).toBe(409)
    const order = await read(await call('GET', '/api/account/orders/NX-AAAAA/returns', { as: 'usr_ada' }))
    expect(order.body.parts).toEqual([
      expect.objectContaining({ merchantId: 'mch_a', seller: 'Acme', status: 'delivered', canRequest: false }),
    ])
    expect(order.body.parts[0].requests).toEqual([expect.objectContaining({ id: filed.body.id, status: 'open', refundMinor: null })])
    expect((await call('GET', '/api/account/orders/NX-AAAAA/returns', { as: 'usr_bob' })).status).toBe(404)
  })

  it('stores photos in the private bucket and serves them only to the owner, never cached', async () => {
    deliver()
    const { body } = await read(await open({ merchantId: 'mch_a', reason: 'damaged' }))
    const up = await read(await call('POST', `/api/account/returns/${body.id}/photos`, { as: 'usr_ada', form: one('photo', webpBytes()) }))
    expect(up.status).toBe(201)
    expect(media.objects.size).toBe(0)
    expect([...priv.objects.keys()]).toEqual([expect.stringMatching(/^returns\/ret_[a-z0-9]+\/ph_[a-z0-9]+\.webp$/)])
    const path = up.body.photos[0] as string
    expect(path).toMatch(/^\/api\/account\/return-photos\/returns\//)
    const mine = await call('GET', path, { as: 'usr_ada' })
    expect(mine.status).toBe(200)
    expect(mine.headers.get('cache-control')).toBe('private, no-store')
    expect((await call('GET', path, { as: 'usr_bob' })).status).toBe(404)
    expect((await call('GET', path)).status).toBe(401)
    // And never through the public media route.
    expect((await call('GET', `/media/u/${[...priv.objects.keys()][0]}`)).status).toBe(404)
    expect((await call('POST', `/api/account/returns/${body.id}/photos`, { as: 'usr_bob', form: one('photo', webpBytes()) })).status).toBe(404)
  })

  it('takes three photos at most, and none once the request is decided', async () => {
    deliver()
    const { body } = await read(await open({ merchantId: 'mch_a', reason: 'damaged' }))
    const upload = () => call('POST', `/api/account/returns/${body.id}/photos`, { as: 'usr_ada', form: one('photo', webpBytes()) })
    for (let i = 0; i < 3; i++) expect((await upload()).status).toBe(201)
    expect((await upload()).status).toBe(409)
    mem.raw.prepare(`UPDATE return_requests SET status = 'rejected', decision_note = 'no', decided_by = 's', decided_at = 'x'`).run()
    mem.raw.prepare(`DELETE FROM return_photos`).run()
    expect((await upload()).status).toBe(409)
    expect(priv.objects.size).toBe(3)
  })
})
