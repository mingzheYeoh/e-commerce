import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { memoryD1, type MemoryD1 } from '../test/d1-memory'
import {
  registerMerchant,
  approveMerchant,
  signIn,
  staffSession,
  beginTotpEnrolment,
  confirmTotpEnrolment,
  type StaffResult,
} from './staff-auth'
import { totpCode } from './totp'
import { KDF_ROUNDS } from './credentials'

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

  it('logs a UNIQUE failure that is not the email race', async () => {
    /*
     * Any UNIQUE is answered 202 so an email race isn't given a different
     * status to read — but a UNIQUE that isn't staff.email means nothing was
     * stored while the applicant was told otherwise, and that must leave a
     * trace. Forced here by pinning the RNG that mints `merchants.id` so it
     * repeats across two registrations with different emails: the second
     * merchants INSERT collides on the primary key, a UNIQUE failure that
     * cannot be staff.email.
     */
    const { db, raw } = memoryD1()
    const real = crypto.getRandomValues.bind(crypto)
    const pinned = vi.spyOn(crypto, 'getRandomValues').mockImplementation(((arr: unknown) => {
      // Only the 12-byte draw `id()` uses is pinned; the salt (16) and the
      // pending-slug token (32) stay genuinely random so this doesn't also
      // collide the slug or reuse a password salt.
      if (arr instanceof Uint8Array && arr.length === 12) return arr
      return real(arr as Parameters<typeof real>[0])
    }) as typeof crypto.getRandomValues)
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await registerMerchant(env(db), good)
      const res = await registerMerchant(env(db), { ...good, email: 'second@example.com' })

      expect(res.status).toBe(202)
      expect(raw.prepare(`SELECT COUNT(*) AS n FROM merchants`).get()).toEqual({ n: 1 })
      expect(quiet).toHaveBeenCalledWith(
        'registration: unexpected UNIQUE, answered 202',
        expect.anything(),
      )
      const [, loggedErr] = quiet.mock.calls[0]
      expect(String(loggedErr)).not.toMatch(/staff\.email/i)
    } finally {
      // A leaked mock here would pin every later test's merchant/staff ids
      // too, so cleanup must run even when an assertion above throws.
      pinned.mockRestore()
      quiet.mockRestore()
    }
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

describe('signing in', () => {
  const req = () => new Request('https://console.test/api/staff/signin', { method: 'POST' })

  /** Registers, approves, and hands back a database with an active merchant. */
  async function activeMerchant() {
    const mem = memoryD1()
    await registerMerchant(env(mem.db), good)
    const id = (mem.raw.prepare(`SELECT id FROM merchants`).get() as { id: string }).id
    const approved = await approveMerchant(env(mem.db), 'stf_platform', id, 'acme')
    if (approved.status !== 200) throw new Error(`fixture approval failed: ${approved.status}`)
    return mem
  }

  /** A request carrying the cookie a StaffResult set. */
  function withCookie(res: StaffResult): Request {
    const cookie = String(res.headers?.['Set-Cookie'] ?? '').split(';')[0]
    return new Request('https://console.test/', { headers: { Cookie: cookie } })
  }

  it('returns an enrolling session when TOTP has never been confirmed', async () => {
    const { db } = await activeMerchant()
    const res = await signIn(env(db), { email: good.email, password: good.password }, req())
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ totpRequired: true })

    const session = await staffSession(env(db), withCookie(res))
    expect(session).toEqual({ kind: 'enrolling', staffId: expect.any(String) })
  })

  it('an enrolling session carries no merchant id, so it cannot be scoped', async () => {
    // The point of the union: scopedTo cannot be called with this, because
    // there is no argument to pass - not because a check refuses it.
    const { db } = await activeMerchant()
    const res = await signIn(env(db), { email: good.email, password: good.password }, req())
    const session = await staffSession(env(db), withCookie(res))
    expect(session).not.toHaveProperty('merchantId')
  })

  it('promotes the session to active once a code verifies', async () => {
    const { db } = await activeMerchant()
    const signedIn = await signIn(env(db), { email: good.email, password: good.password }, req())
    const enrolling = (await staffSession(env(db), withCookie(signedIn)))!

    const begun = await beginTotpEnrolment(env(db), enrolling)
    const secret = (begun.body as { secret: string }).secret
    await confirmTotpEnrolment(env(db), enrolling, { code: await totpCode(secret) })

    const after = await staffSession(env(db), withCookie(signedIn))
    expect(after).toMatchObject({ kind: 'active', merchantId: expect.any(String), scope: 'merchant' })
  })

  it('a wrong code neither promotes the session nor consumes it', async () => {
    const { db } = await activeMerchant()
    const signedIn = await signIn(env(db), { email: good.email, password: good.password }, req())
    const enrolling = (await staffSession(env(db), withCookie(signedIn)))!
    await beginTotpEnrolment(env(db), enrolling)

    const res = await confirmTotpEnrolment(env(db), enrolling, { code: '000000' })
    expect(res.status).toBe(400)
    expect(await staffSession(env(db), withCookie(signedIn))).toMatchObject({ kind: 'enrolling' })
  })

  it('refuses a wrong password without saying which half was wrong', async () => {
    const { db } = await activeMerchant()
    const res = await signIn(env(db), { email: good.email, password: 'wrong-but-long-enough' }, req())
    expect(res.status).toBe(401)
    expect(JSON.stringify(res.body)).not.toMatch(/password|email|unknown user/i)
  })

  it('locks the account after repeated failures', async () => {
    const { db } = await activeMerchant()
    for (let i = 0; i < 5; i++) {
      await signIn(env(db), { email: good.email, password: 'wrong-but-long-enough' }, req())
    }
    const res = await signIn(env(db), { email: good.email, password: good.password }, req())
    expect(res.status).toBe(423)
  })

  it('requires the second factor on every later sign-in', async () => {
    const { db } = await activeMerchant()
    // enrol once
    const first = await signIn(env(db), { email: good.email, password: good.password }, req())
    const enrolling = (await staffSession(env(db), withCookie(first)))!
    const begun = await beginTotpEnrolment(env(db), enrolling)
    const secret = (begun.body as { secret: string }).secret
    await confirmTotpEnrolment(env(db), enrolling, { code: await totpCode(secret) })

    // sign in again: password alone must not produce an active session
    const second = await signIn(env(db), { email: good.email, password: good.password }, req())
    expect(second.body).toMatchObject({ totpRequired: true })
    expect(await staffSession(env(db), withCookie(second))).toMatchObject({ kind: 'enrolling' })
  })

  /*
   * The register-then-sign-in probe. Registration lets the applicant choose
   * the password, so an attacker registers a victim's address with one of
   * their own and signs in with it. If that answer differed from a wrong
   * password's, it would say whether the probe had just created the account
   * (the password is the attacker's, so it matches) or the address already
   * had one (it is someone else's, so it does not).
   */
  it('answers the correct password of an attacker-created pending account as a wrong one', async () => {
    const attacker = memoryD1()
    await registerMerchant(env(attacker.db), good)
    const probe = await signIn(env(attacker.db), { email: good.email, password: good.password }, req())

    const { db } = await activeMerchant()
    const wrong = await signIn(env(db), { email: good.email, password: 'wrong-but-long-enough' }, req())
    const unknown = await signIn(env(db), { email: 'nobody@example.com', password: good.password }, req())

    expect(probe.status).toBe(401)
    expect(probe).toEqual(wrong)
    expect(unknown).toEqual(wrong)
    expect(probe.headers).toBeUndefined()
  })

  it('backs off an attacker-created pending account just as it backs off an existing one', async () => {
    /*
     * Without this, the status is equal and six attempts still read the
     * difference: a pre-existing account locks and answers 423, an
     * attacker-created one never would.
     */
    const attacker = memoryD1()
    await registerMerchant(env(attacker.db), good)
    for (let i = 0; i < 5; i++) {
      await signIn(env(attacker.db), { email: good.email, password: good.password }, req())
    }
    const probe = await signIn(env(attacker.db), { email: good.email, password: good.password }, req())

    const existing = await activeMerchant()
    for (let i = 0; i < 5; i++) {
      await signIn(env(existing.db), { email: good.email, password: 'wrong-but-long-enough' }, req())
    }
    const locked = await signIn(env(existing.db), { email: good.email, password: good.password }, req())

    expect(probe.status).toBe(423)
    expect(probe).toEqual(locked)
    const row = attacker.raw.prepare(`SELECT failed_attempts, locked_until FROM staff`).get() as {
      failed_attempts: number
      locked_until: string | null
    }
    expect(row.failed_attempts).toBe(5)
    expect(row.locked_until).not.toBeNull()
  })

  it('pays the same KDF for an unknown email, a wrong password and a pending account', async () => {
    // A path that skipped the derivation would answer measurably faster, and
    // the speed would say what the status was careful not to.
    const attacker = memoryD1()
    await registerMerchant(env(attacker.db), good)
    const { db } = await activeMerchant()

    const spy = vi.spyOn(crypto.subtle, 'deriveBits')
    try {
      const passes = async (run: () => Promise<unknown>) => {
        spy.mockClear()
        await run()
        return spy.mock.calls.length
      }
      const counts = [
        await passes(() => signIn(env(db), { email: 'nobody@example.com', password: good.password }, req())),
        await passes(() => signIn(env(db), { email: good.email, password: 'wrong-but-long-enough' }, req())),
        await passes(() => signIn(env(attacker.db), { email: good.email, password: good.password }, req())),
      ]
      expect(counts).toEqual([KDF_ROUNDS, KDF_ROUNDS, KDF_ROUNDS])
    } finally {
      spy.mockRestore()
    }
  })

  it('sets a strict, script-proof cookie and stores only its hash', async () => {
    const { db, raw } = await activeMerchant()
    const res = await signIn(env(db), { email: good.email, password: good.password }, req())
    const cookie = String(res.headers?.['Set-Cookie'])
    expect(cookie).toMatch(/^nexus_staff=[^;]+/)
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) {
      expect(cookie).toContain(attr)
    }
    const token = cookie.split(';')[0].split('=').slice(1).join('=')
    expect(JSON.stringify(raw.prepare(`SELECT * FROM staff_sessions`).all())).not.toContain(token)
  })

  it('will not issue a new secret once one is confirmed', async () => {
    /*
     * Every sign-in is an enrolling session, including the hundredth. If
     * beginning enrolment again minted a fresh secret, a password alone would
     * be enough to replace the second factor and confirm the replacement.
     */
    const { db, raw } = await activeMerchant()
    const first = await signIn(env(db), { email: good.email, password: good.password }, req())
    const enrolling = (await staffSession(env(db), withCookie(first)))!
    const secret = ((await beginTotpEnrolment(env(db), enrolling)).body as { secret: string }).secret
    await confirmTotpEnrolment(env(db), enrolling, { code: await totpCode(secret) })

    const second = await signIn(env(db), { email: good.email, password: good.password }, req())
    const again = (await staffSession(env(db), withCookie(second)))!
    const res = await beginTotpEnrolment(env(db), again)
    expect(res.status).toBe(409)
    expect(res.body).not.toHaveProperty('secret')
    expect(raw.prepare(`SELECT totp_secret FROM staff`).get()).toEqual({ totp_secret: secret })

    // The existing authenticator is what gets this session the rest of the way.
    await confirmTotpEnrolment(env(db), again, { code: await totpCode(secret) })
    expect(await staffSession(env(db), withCookie(second))).toMatchObject({ kind: 'active' })
  })

  it('promotes only the session that verified the code', async () => {
    // Promoting every pending session for the staff member would promote a
    // thief's password-only session along with the owner's.
    const { db } = await activeMerchant()
    const mine = await signIn(env(db), { email: good.email, password: good.password }, req())
    const theirs = await signIn(env(db), { email: good.email, password: good.password }, req())
    const enrolling = (await staffSession(env(db), withCookie(mine)))!
    const secret = ((await beginTotpEnrolment(env(db), enrolling)).body as { secret: string }).secret
    await confirmTotpEnrolment(env(db), enrolling, { code: await totpCode(secret) })

    expect(await staffSession(env(db), withCookie(mine))).toMatchObject({ kind: 'active' })
    expect(await staffSession(env(db), withCookie(theirs))).toMatchObject({ kind: 'enrolling' })
  })

  it('backs off wrong codes, and a correct password does not wipe the count', async () => {
    /*
     * Six digits is a million codes and three are valid at any moment. With a
     * password in hand and no limit on codes, that is an afternoon's work.
     * The count is only cleared by a code that verifies: if the password
     * cleared it, signing in again between guesses would reset the backoff
     * forever.
     */
    const { db } = await activeMerchant()
    const first = await signIn(env(db), { email: good.email, password: good.password }, req())
    const enrolling = (await staffSession(env(db), withCookie(first)))!
    const secret = ((await beginTotpEnrolment(env(db), enrolling)).body as { secret: string }).secret
    for (let i = 0; i < 4; i++) await confirmTotpEnrolment(env(db), enrolling, { code: '000000' })

    const second = await signIn(env(db), { email: good.email, password: good.password }, req())
    expect(second.status).toBe(200)
    const again = (await staffSession(env(db), withCookie(second)))!
    await confirmTotpEnrolment(env(db), again, { code: '000000' })

    const res = await confirmTotpEnrolment(env(db), again, { code: await totpCode(secret) })
    expect(res.status).toBe(423)
    expect(await staffSession(env(db), withCookie(second))).toMatchObject({ kind: 'enrolling' })
    const blocked = await signIn(env(db), { email: good.email, password: good.password }, req())
    expect(blocked.status).toBe(423)
  })
})
