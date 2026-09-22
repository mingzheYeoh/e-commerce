import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { memoryD1 } from '../test/d1-memory'
import { registerMerchant, approveMerchant } from './staff-auth'

/*
 * `tooCommon` reaches Have I Been Pwned for real. Left alone these tests
 * would be slow and network-dependent, and — offline, where the check fails
 * open by design — the breached-password case would go green because nobody
 * answered rather than because the password was refused. The stub answers the
 * way the range endpoint does, for the one password a test plants. Same shape
 * and the same reason as auth.spec.ts.
 */
const BREACHED = ['password123']

async function sha1Suffix(password: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(password))
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
    .slice(5)
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      // Nothing else in this module talks to the network. A request to
      // anywhere else is a mistake worth failing on rather than answering.
      if (!String(url).includes('pwnedpasswords.com')) throw new Error(`unexpected fetch: ${url}`)
      const seen = await Promise.all(BREACHED.map(async (p) => `${await sha1Suffix(p)}:50000`))
      return new Response(seen.join('\r\n'), { status: 200 })
    }),
  )
})

afterEach(() => vi.unstubAllGlobals())

const env = (db: D1Database) => ({ ORDERS: db })
const good = { email: 'owner@example.com', name: 'Acme', slug: 'acme', password: 'Xq7!vurnLp2$wedge' }

describe('registerMerchant', () => {
  it('creates a pending merchant and its owner', async () => {
    const { db, raw } = memoryD1()
    const res = await registerMerchant(env(db), good)
    expect(res.status).toBe(201)

    const merchant = raw.prepare(`SELECT status, slug FROM merchants`).get()
    expect(merchant).toMatchObject({ status: 'pending', slug: 'acme' })

    const staff = raw.prepare(`SELECT scope, role, totp_secret FROM staff`).get()
    expect(staff).toMatchObject({ scope: 'merchant', role: 'owner', totp_secret: null })
  })

  it('never stores the password', async () => {
    const { db, raw } = memoryD1()
    await registerMerchant(env(db), good)
    const row = JSON.stringify(raw.prepare(`SELECT * FROM staff`).get())
    expect(row).not.toContain(good.password)
  })

  it('refuses a password found in a breach corpus', async () => {
    const { db } = memoryD1()
    const res = await registerMerchant(env(db), { ...good, password: 'password123' })
    expect(res.status).toBe(400)
  })

  it('refuses a duplicate email without saying it is taken', async () => {
    // The same reason the customer side refuses to confirm an address exists:
    // a signup form that distinguishes is an account-enumeration oracle.
    const { db } = memoryD1()
    await registerMerchant(env(db), good)
    const res = await registerMerchant(env(db), { ...good, slug: 'other' })
    expect(res.status).toBe(202)
    expect(JSON.stringify(res.body)).not.toMatch(/taken|exists|duplicate/i)
  })

  it('leaves nothing behind when the slug is already used', async () => {
    const { db, raw } = memoryD1()
    await registerMerchant(env(db), good)
    const res = await registerMerchant(env(db), { ...good, email: 'other@example.com' })
    // A merchant row without its owner is an application nobody can ever claim.
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM merchants`).get()).toEqual({ n: 1 })
    /*
     * And it says which of the two collided. The taken slug is the one answer
     * this module owes the applicant — they chose it and can choose again —
     * so it must not arrive as the 503 an unrecognised failure gets, nor as
     * the 202 a taken address gets.
     */
    expect(res.status).toBe(409)
  })
})

describe('approveMerchant', () => {
  it('turns a pending application active', async () => {
    const { db, raw } = memoryD1()
    await registerMerchant(env(db), good)
    const id = (raw.prepare(`SELECT id FROM merchants`).get() as { id: string }).id
    const res = await approveMerchant(env(db), 'stf_platform', id)
    expect(res.status).toBe(200)
    expect(raw.prepare(`SELECT status FROM merchants`).get()).toEqual({ status: 'active' })
  })

  it('records who approved it', async () => {
    const { db, raw } = memoryD1()
    await registerMerchant(env(db), good)
    const id = (raw.prepare(`SELECT id FROM merchants`).get() as { id: string }).id
    await approveMerchant(env(db), 'stf_platform', id)
    const audit = raw.prepare(`SELECT actor_id, action, merchant_id FROM audit_log`).get()
    expect(audit).toMatchObject({ actor_id: 'stf_platform', merchant_id: id })
  })
})
