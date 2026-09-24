import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { memoryD1, type MemoryD1 } from '../test/d1-memory'
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
const good = { email: 'owner@example.com', name: 'Acme', password: 'Xq7!vurnLp2$wedge' }

const merchantIds = (raw: MemoryD1['raw']) =>
  (raw.prepare(`SELECT id FROM merchants ORDER BY rowid`).all() as { id: string }[]).map(
    (r) => r.id,
  )

describe('registerMerchant', () => {
  it('creates a pending merchant and its owner', async () => {
    const { db, raw } = memoryD1()
    const res = await registerMerchant(env(db), good)
    // 202, not 201: a fresh application and a duplicate email must return the
    // identical status, or the status line becomes a yes/no oracle on its own,
    // read before the (identical) body is even parsed. See the duplicate-email
    // test below.
    expect(res.status).toBe(202)

    const merchant = raw.prepare(`SELECT status, slug FROM merchants`).get()
    expect(merchant).toMatchObject({
      status: 'pending',
      slug: expect.stringMatching(/^pending_[a-z0-9]{32,}$/),
    })

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
    //
    // 202 here, and 202 for a fresh application above — the same code, not
    // just the same body. A registration form that returns 201 for "created"
    // and 202 for "already exists" has not fixed the oracle, only moved it
    // into the status line, which is readable before any body is, without
    // parsing anything. Do not "fix" the success case back to 201 for REST
    // tidiness; that reopens exactly this hole.
    //
    // This is now the whole answer to one- and two-request probing, because
    // the applicant supplies nothing another request can collide with. The
    // timing difference (a fresh application pays for a write a duplicate
    // skips) is the residual, and it is deferred rather than closed.
    const { db } = memoryD1()
    const first = await registerMerchant(env(db), good)
    const res = await registerMerchant(env(db), good)
    expect(res).toEqual(first)
    expect(JSON.stringify(res.body)).not.toMatch(/taken|exists|duplicate/i)
  })

  it('ignores a supplied slug and mints a pending one', async () => {
    /*
     * An applicant-chosen slug is what let two probes read whether an email
     * was registered: the second collided only if the first had created a
     * merchant. Ignored rather than refused, so a caller still sending the
     * old shape is not broken — it just does not get to pick.
     */
    const { db, raw } = memoryD1()
    const res = await registerMerchant(env(db), { ...good, slug: 'acme' })
    expect(res.status).toBe(202)
    const { slug } = raw.prepare(`SELECT slug FROM merchants`).get() as { slug: string }
    expect(slug).not.toBe('acme')
    expect(slug).toMatch(/^pending_[a-z0-9]{32,}$/)
  })

  it('rolls the merchant back when the owner row is the statement that fails', async () => {
    /*
     * The failure the batch exists for: two registrations race for one
     * address, both pass the email SELECT, and the loser's merchant INSERT
     * succeeds before its staff INSERT fails on staff.email UNIQUE. Unbatched,
     * that leaves a pending merchant nobody owns.
     *
     * The rival's row is planted as the batch starts — after the pre-check has
     * looked and found nothing, which is the gap a concurrent request lands
     * in. A collision planted before the pre-check would never reach the
     * batch; one on the first statement would pass with the batch split,
     * since nothing would have been written to roll back.
     */
    const { db, raw } = memoryD1()
    const batch = db.batch.bind(db)
    db.batch = async <T,>(statements: D1PreparedStatement[]) => {
      raw
        .prepare(
          `INSERT INTO staff (id, email, scope, merchant_id, role, password_hash, password_salt,
                              iterations, kdf_rounds)
           VALUES ('stf_rival', ?, 'platform', NULL, 'admin', 'h', 's', 1, 1)`,
        )
        .run(good.email)
      return batch<T>(statements)
    }

    const res = await registerMerchant(env(db), good)
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM merchants`).get()).toEqual({ n: 0 })
    // And the loser hears what any taken address hears.
    expect(res.status).toBe(202)
  })
})

describe('approveMerchant', () => {
  it('turns a pending application active', async () => {
    const { db, raw } = memoryD1()
    await registerMerchant(env(db), good)
    const id = (raw.prepare(`SELECT id FROM merchants`).get() as { id: string }).id
    const res = await approveMerchant(env(db), 'stf_platform', id, 'acme')
    expect(res.status).toBe(200)
    expect(raw.prepare(`SELECT status FROM merchants`).get()).toEqual({ status: 'active' })
  })

  it('assigns the storefront address the platform chose', async () => {
    const { db, raw } = memoryD1()
    await registerMerchant(env(db), good)
    const [id] = merchantIds(raw)
    await approveMerchant(env(db), 'stf_platform', id, 'Acme-Tools')
    expect(raw.prepare(`SELECT slug FROM merchants`).get()).toEqual({ slug: 'acme-tools' })
  })

  it('refuses a malformed storefront address and leaves the application pending', async () => {
    const { db, raw } = memoryD1()
    await registerMerchant(env(db), good)
    const [id] = merchantIds(raw)
    // The underscore matters most: it is what keeps an approved address from
    // ever equalling a minted `pending_` placeholder.
    for (const bad of ['', 'pending_x', '-acme', 'acme tools', 'a'.repeat(41), 42]) {
      const res = await approveMerchant(env(db), 'stf_platform', id, bad)
      expect(res.status).toBe(400)
    }
    expect(raw.prepare(`SELECT status FROM merchants`).get()).toEqual({ status: 'pending' })
  })

  it('refuses an address another merchant holds with 409', async () => {
    // 409 here, where registration never says "taken": the caller is platform
    // staff, who can already list every merchant and its address.
    const { db, raw } = memoryD1()
    await registerMerchant(env(db), good)
    await registerMerchant(env(db), { ...good, email: 'second@example.com' })
    const [first, second] = merchantIds(raw)
    await approveMerchant(env(db), 'stf_platform', first, 'acme')

    const res = await approveMerchant(env(db), 'stf_platform', second, 'acme')
    expect(res.status).toBe(409)
    expect(raw.prepare(`SELECT status FROM merchants WHERE id = ?`).get(second)).toEqual({
      status: 'pending',
    })
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM audit_log`).get()).toEqual({ n: 1 })
  })

  it('records who approved it', async () => {
    const { db, raw } = memoryD1()
    await registerMerchant(env(db), good)
    const id = (raw.prepare(`SELECT id FROM merchants`).get() as { id: string }).id
    await approveMerchant(env(db), 'stf_platform', id, 'acme')
    const audit = raw.prepare(`SELECT actor_id, action, merchant_id FROM audit_log`).get()
    expect(audit).toMatchObject({
      actor_id: 'stf_platform',
      action: 'merchants.approve',
      merchant_id: id,
    })
  })

  it('writes no second audit row when the application is no longer pending', async () => {
    // Two admins approving at once: only the UPDATE that changed a row may
    // record an approval, or the log names someone who approved nothing.
    const { db, raw } = memoryD1()
    await registerMerchant(env(db), good)
    const [id] = merchantIds(raw)
    await approveMerchant(env(db), 'stf_first', id, 'acme')

    const res = await approveMerchant(env(db), 'stf_second', id, 'acme-two')
    expect(res.status).toBe(404)
    expect(raw.prepare(`SELECT actor_id FROM audit_log`).all()).toEqual([{ actor_id: 'stf_first' }])
    expect(raw.prepare(`SELECT slug FROM merchants`).get()).toEqual({ slug: 'acme' })
  })

  it('answers 503 rather than throwing when the database fails', async () => {
    const { db, raw } = memoryD1()
    await registerMerchant(env(db), good)
    const [id] = merchantIds(raw)
    db.batch = async () => {
      throw new Error('D1_ERROR: storage unavailable')
    }
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await approveMerchant(env(db), 'stf_platform', id, 'acme')
    quiet.mockRestore()
    expect(res.status).toBe(503)
  })
})
