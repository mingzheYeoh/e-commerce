// @vitest-environment node
import { describe, it, expect } from 'vitest'
import worker, { type Env } from './index'
import { memoryD1 } from '../test/d1-memory'
import { sha256 } from './credentials'

const post = (env: Partial<Env>, body: unknown, cookie?: string) =>
  worker.fetch(
    new Request('https://api.test/api/orders', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-connecting-ip': '203.0.113.9',
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
    env as Env,
  )

/** A database holding one account with a live session, and the cookie that carries it. */
async function signedIn() {
  const mem = memoryD1()
  mem.raw.prepare(`INSERT INTO users (id, email, name, password_hash, password_salt, iterations) VALUES ('usr_ada', 'ada@example.com', 'Ada', 'h', 's', 1)`).run()
  mem.raw
    .prepare(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, 'usr_ada', '2999-01-01T00:00:00Z')`)
    .run(await sha256('tok-ada'))
  return { ...mem, cookie: 'nexus_session=tok-ada' }
}

describe('POST /api/orders', () => {
  it('is rate limited per IP before anything is read, with a Retry-After', async () => {
    // Payment is simulated, so nothing else stops a script placing orders that
    // take real stock and inflate what the platform pays merchants.
    const { db, rows } = memoryD1()
    const keys: string[] = []
    const refuse = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: false }) }
    const res = await post({ ORDERS: db, ORDER_LIMITER: refuse }, { id: 'NX-4K2P9' })
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('60')
    expect(keys).toEqual(['order:203.0.113.9'])
    expect(rows('orders')).toEqual([])
  })

  it('lets a request through while the limit allows it', async () => {
    const { db, cookie } = await signedIn()
    const allow = { limit: async () => ({ success: true }) }
    // Through the limiter to placeOrder, which refuses this body on its merits.
    expect((await post({ ORDERS: db, ORDER_LIMITER: allow }, { id: 'bad' }, cookie)).status).toBe(400)
  })

  it('refuses a shopper who is not signed in, before reading the order', async () => {
    const { db, rows } = memoryD1()
    const allow = { limit: async () => ({ success: true }) }
    const res = await post({ ORDERS: db, ORDER_LIMITER: allow }, { id: 'NX-4K2P9' })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ code: 'signin' })
    expect(rows('orders')).toEqual([])
  })
})

describe('GET /api/orders/:id', () => {
  it('is never cached, whoever asks and whether or not the order exists', async () => {
    const { db } = memoryD1()
    const res = await worker.fetch(new Request('https://api.test/api/orders/NX-4K2P9'), { ORDERS: db } as Env)
    expect(res.status).toBe(404)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
  })
})
