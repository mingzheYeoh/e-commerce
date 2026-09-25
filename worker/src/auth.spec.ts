import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  register,
  login,
  logout,
  verifyEmail,
  requestPasswordReset,
  resetPassword,
  purgeExpired,
  sessionUser,
  readCookie,
  authDefences,
  changePassword,
  requestEmailChange,
  revokeOtherSessions,
  deleteAccount,
  startTotpEnrolment,
  confirmTotpEnrolment,
  disableTotp,
  accountSettings,
  SESSION_COOKIE,
  MAX_PBKDF2_ITERATIONS,
  type AuthEnv,
  type User,
} from './auth'
import { totpCode } from './totp'
import { memoryD1 } from '../test/d1-memory'

/*
 * These run against a real SQLite database loaded from the project's own
 * schema.sql, not a stand-in. The stand-in that used to be here matched
 * statements with `sql.includes(...)`, grew into a small and wrong SQL engine,
 * and earned its removal by hiding a bug — see test/d1-memory.ts.
 */

/* ---------------------------------------------------------------- outbound */

/** Every message the code tried to send, as the provider would have seen it. */
let sent: { to: string; subject: string; text: string }[] = []
/** SHA-1 suffixes the breach service should claim to have seen. */
let breached = new Map<string, number>()

async function sha1Suffix(password: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(password))
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
    .slice(5)
}

/** Marks a password as one the breach service will report. */
async function markBreached(password: string, count = 50_000) {
  breached.set(await sha1Suffix(password), count)
}

function captureSends(_url: string, init?: RequestInit): Response {
  const parsed = JSON.parse(String(init?.body)) as { to: string[]; subject: string; text: string }
  sent.push({ to: parsed.to[0], subject: parsed.subject, text: parsed.text })
  return new Response('{}', { status: 200 })
}

beforeEach(() => {
  sent = []
  breached = new Map()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('pwnedpasswords.com')) {
        // The real service answers with every suffix sharing the prefix. Only
        // the ones a test planted come back; anything else is a miss.
        return new Response([...breached].map(([s, n]) => `${s}:${n}`).join('\r\n'), { status: 200 })
      }
      return captureSends(url, init)
    }),
  )
})

afterEach(() => vi.unstubAllGlobals())

/** Makes the mail provider refuse, the way an unverified sending domain does. */
function refuseSends() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).includes('pwnedpasswords.com')) return new Response('', { status: 200 })
      return new Response('{"message":"You can only send to your own address"}', { status: 403 })
    }),
  )
}

/* ------------------------------------------------------------------ set-up */

function envWith(over: Partial<AuthEnv> = {}) {
  const { db, raw, rows } = memoryD1()
  const env: AuthEnv = {
    ORDERS: db,
    RESEND_API_KEY: 'test-key',
    MAIL_FROM: 'NEXUS <test@example.com>',
    ALLOWED_ORIGIN: 'https://shop.example',
    ...over,
  }
  return {
    env,
    raw,
    users: () => rows('users'),
    user: () => rows('users')[0],
    sessions: () => rows('sessions'),
    tokens: () => rows('email_tokens'),
    codes: () => rows('recovery_codes'),
  }
}

const req = (headers: Record<string, string> = {}) =>
  new Request('https://api.test/', { headers: { 'cf-connecting-ip': '198.51.100.7', ...headers } })

const withCookie = (cookie: string) => new Request('https://api.test/', { headers: { cookie } })

const cookieFrom = (result: unknown) => (result as { cookie: string }).cookie
const tokenFrom = (cookie: string) => cookie.slice(cookie.indexOf('=') + 1, cookie.indexOf(';'))

/** Pulls the one-shot code out of whatever link the email carried. */
const linkFrom = (text: string) =>
  new URL(text.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!

const account = { name: 'Ada Lovelace', email: 'ada@example.com', password: 'correct horse battery' }

/** Registers and clicks the link, which is how an account becomes usable. */
async function signUpAndVerify(env: AuthEnv) {
  await register(env, account, req())
  return verifyEmail(env, { token: linkFrom(sent[0].text) })
}

/** A signed-in user, which is what every settings call takes. */
async function signedIn(env: AuthEnv): Promise<{ user: User; request: Request }> {
  const result = await signUpAndVerify(env)
  const request = withCookie(`${SESSION_COOKIE}=${tokenFrom(cookieFrom(result))}`)
  return { user: (await sessionUser(env, request))!, request }
}

/** One pass of PBKDF2 over the password — what rows looked like before chaining. */
async function legacyHash(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100_000 },
      key,
      256,
    ),
  )
  const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
  return { hash: b64(bits), salt: b64(salt) }
}

/* --------------------------------------------------------------- register */

describe('register', () => {
  it('creates the account but does not sign anyone in yet', async () => {
    const { env, users, sessions, user } = envWith()
    const result = await register(env, account, req())

    expect(result.status).toBe(200)
    expect(users()).toHaveLength(1)
    // No session: the address has been typed, not proven.
    expect(sessions()).toHaveLength(0)
    expect(user().email_verified_at).toBeNull()
    expect(user().email).toBe('ada@example.com')
  })

  it('hashes new accounts at the full chained work factor', async () => {
    // Six passes of 100,000, which is how the runtime's per-call ceiling is
    // got around.
    const { env, user } = envWith()
    await register(env, account, req())
    expect(user().kdf_rounds).toBe(6)
  })

  it('answers identically whether or not the address is already taken', async () => {
    const { env } = envWith()
    const first = await register(env, account, req())
    const second = await register(env, { ...account, name: 'Someone Else' }, req())

    expect(second.status).toBe(first.status)
    expect(second.body).toEqual(first.body)
  })

  it('tells the difference only to the inbox that owns the address', async () => {
    const { env, users } = envWith()
    await signUpAndVerify(env)
    sent = []

    await register(env, account, req())

    expect(users(), 'no second account').toHaveLength(1)
    expect(sent[0].subject).toMatch(/someone tried/i)
    expect(sent[0].text).not.toContain(account.password)
  })

  it('sends a fresh link instead when the account was never confirmed', async () => {
    /*
     * The dead end this fixes. The link expires after a day; registering again
     * answered "you already have an account, sign in"; signing in answered
     * "confirm your email first". There was no way out and the address was
     * taken.
     */
    const { env, users } = envWith()
    await register(env, account, req())
    sent = []

    await register(env, account, req())

    expect(users()).toHaveLength(1)
    expect(sent[0].subject, 'a new link, not "sign in instead"').toMatch(/confirm/i)
    expect((await verifyEmail(env, { token: linkFrom(sent[0].text) })).status).toBe(200)
  })

  it('replaces the password on an unconfirmed account, and kills the old link', async () => {
    /*
     * Account pre-hijacking. Someone signs up with an address that is not
     * theirs and waits; the day its real owner registers and confirms, the
     * squatter is holding a working password. Overwriting means the surviving
     * credential belongs to whoever last typed one before the inbox was
     * proven — the step the squatter can never take.
     */
    const { env } = envWith()
    await register(env, { ...account, password: 'the squatter password' }, req())
    const squatterLink = linkFrom(sent[0].text)
    sent = []

    await register(env, { ...account, password: 'the real owner password' }, req())
    await verifyEmail(env, { token: linkFrom(sent[0].text) })

    expect(
      (await login(env, { email: account.email, password: 'the real owner password' }, req())).status,
    ).toBe(200)
    expect(
      (await login(env, { email: account.email, password: 'the squatter password' }, req())).status,
      'the earlier password must not survive',
    ).toBe(401)
    expect(
      (await verifyEmail(env, { token: squatterLink })).status,
      'and neither must the earlier link',
    ).toBe(400)
  })

  it('refuses a password that is already in a breach corpus', async () => {
    /*
     * Length rules stop nothing. `Password1!` clears most of them and sits in
     * breach corpora millions of times over; what predicts a guess is whether
     * someone has already guessed it.
     */
    const { env, users } = envWith()
    await markBreached('Password1!')

    const result = await register(env, { ...account, password: 'Password1!' }, req())
    expect(result.status).toBe(400)
    expect((result.body as { error: string }).error).toMatch(/breaches/)
    expect(users()).toHaveLength(0)
  })

  it('sends only the first five characters of the hash to check that', async () => {
    const { env } = envWith()
    await register(env, account, req())

    const calls = vi.mocked(fetch).mock.calls.map(([url]) => String(url))
    const lookup = calls.find((url) => url.includes('pwnedpasswords'))!
    const prefix = lookup.slice(lookup.lastIndexOf('/') + 1)

    // k-anonymity: five hex characters and nothing else. The password, the full
    // hash and the account it belongs to never leave the worker.
    expect(prefix).toMatch(/^[0-9A-F]{5}$/)
    expect(calls.join(' ')).not.toContain(account.password)
  })

  it('still registers when the breach service cannot be reached', async () => {
    // An outage somewhere else is not a reason to close registration.
    const { env, users } = envWith()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes('pwnedpasswords.com')) throw new Error('offline')
        return captureSends(url, init)
      }),
    )

    expect((await register(env, account, req())).status).toBe(200)
    expect(users()).toHaveLength(1)
  })

  it('refuses to register at all when it cannot send email', async () => {
    const { env, users } = envWith({ RESEND_API_KEY: undefined })
    expect((await register(env, account, req())).status).toBe(503)
    expect(users()).toHaveLength(0)
  })

  it('never stores the password, and never stores the raw link token', async () => {
    const { env, users, tokens } = envWith()
    await register(env, account, req())

    const written = JSON.stringify({ users: users(), tokens: tokens() })
    expect(written).not.toContain(account.password)
    expect(written, 'the tokens table holds a hash, not the link').not.toContain(
      linkFrom(sent[0].text),
    )
  })

  it('does not claim to have sent an email it could not send', async () => {
    const { env, users } = envWith()
    refuseSends()

    const result = await register(env, account, req())
    expect(result.status).toBe(503)
    expect((result.body as { error: string }).error).toMatch(/could not send/i)
    // The half-made account is undone; left behind, the address is taken and a
    // retry hits the unique constraint.
    expect(users()).toHaveLength(0)
  })

  it('refuses a password too short to be one, and an address that is not one', async () => {
    const { env, users } = envWith()
    expect((await register(env, { ...account, password: 'short' }, req())).status).toBe(400)
    expect((await register(env, { ...account, email: 'ada' }, req())).status).toBe(400)
    expect(users()).toHaveLength(0)
  })

  it('refuses when the signup limiter says so, before touching anything', async () => {
    const { env, users } = envWith({ SIGNUP_LIMITER: { limit: async () => ({ success: false }) } })
    const result = await register(env, account, req())

    expect(result.status).toBe(429)
    expect(users()).toHaveLength(0)
    expect(sent).toHaveLength(0)
  })
})

/* ----------------------------------------------------------------- verify */

describe('verifying an email', () => {
  it('confirms the address and signs them in', async () => {
    const { env, user, sessions } = envWith()
    const result = await signUpAndVerify(env)

    expect(result.status).toBe(200)
    expect(user().email_verified_at).not.toBeNull()
    expect(sessions()).toHaveLength(1)
    expect(cookieFrom(result)).toContain('HttpOnly')
  })

  it('will not accept the same link twice', async () => {
    const { env } = envWith()
    await register(env, account, req())
    const token = linkFrom(sent[0].text)

    expect((await verifyEmail(env, { token })).status).toBe(200)
    expect((await verifyEmail(env, { token })).status).toBe(400)
  })

  it('refuses an expired link', async () => {
    const { env, raw } = envWith()
    await register(env, account, req())
    raw.prepare(`UPDATE email_tokens SET expires_at = ?`).run(new Date(Date.now() - 1000).toISOString())

    expect((await verifyEmail(env, { token: linkFrom(sent[0].text) })).status).toBe(400)
  })

  it('says the same thing about unknown, expired and spent links', async () => {
    const { env } = envWith()
    await register(env, account, req())
    const token = linkFrom(sent[0].text)
    await verifyEmail(env, { token })

    const spent = await verifyEmail(env, { token })
    const unknown = await verifyEmail(env, { token: 'never-issued' })
    expect(unknown.body).toEqual(spent.body)
  })

  it('refuses a request with no token at all', async () => {
    const { env } = envWith()
    expect((await verifyEmail(env, {})).status).toBe(400)
  })
})

/* ------------------------------------------------------------------ login */

describe('login', () => {
  it('accepts the right password once the address is confirmed', async () => {
    const { env } = envWith()
    await signUpAndVerify(env)
    expect(
      (await login(env, { email: account.email, password: account.password }, req())).status,
    ).toBe(200)
  })

  it('will not sign in an address nobody has confirmed', async () => {
    const { env } = envWith()
    await register(env, account, req())
    expect(
      (await login(env, { email: account.email, password: account.password }, req())).status,
    ).toBe(403)
  })

  it('says exactly the same thing about a wrong password and an unknown account', async () => {
    const { env } = envWith()
    await signUpAndVerify(env)

    const wrong = await login(env, { email: account.email, password: 'wrong one' }, req())
    const unknown = await login(env, { email: 'nobody@example.com', password: 'wrong one' }, req())

    expect(unknown.status).toBe(wrong.status)
    expect(unknown.body).toEqual(wrong.body)
  })

  it('finds the account however the email was capitalised', async () => {
    const { env } = envWith()
    await signUpAndVerify(env)
    expect(
      (await login(env, { email: 'ADA@Example.com', password: account.password }, req())).status,
    ).toBe(200)
  })

  it('still verifies a hash written before chaining existed, and upgrades it', async () => {
    /*
     * The promise the stored round count exists to keep. A row hashed with one
     * pass — which is every row written before this — has to keep working, and
     * get stronger the next time its owner signs in rather than being locked
     * out by a change they did not ask for.
     */
    const { env, raw, user } = envWith()
    await signUpAndVerify(env)

    const legacy = await legacyHash(account.password)
    raw
      .prepare(`UPDATE users SET password_hash = ?, password_salt = ?, kdf_rounds = 1`)
      .run(legacy.hash, legacy.salt)
    expect(user().kdf_rounds).toBe(1)

    expect(
      (await login(env, { email: account.email, password: account.password }, req())).status,
      'the old hash still verifies',
    ).toBe(200)
    expect(user().kdf_rounds, 'and is upgraded on the way through').toBe(6)
    expect(
      (await login(env, { email: account.email, password: account.password }, req())).status,
      'the upgraded row accepts the same password',
    ).toBe(200)
  })

  it('refuses when the login limiter says so, without doing the work', async () => {
    const { env } = envWith({ LOGIN_LIMITER: { limit: async () => ({ success: false }) } })
    await signUpAndVerify(env)

    const result = await login(env, { email: account.email, password: account.password }, req())
    expect(result.status).toBe(429)
    expect(result).toHaveProperty('retryAfter')
  })
})

/* ---------------------------------------------------------------- backoff */

describe('per-account backoff', () => {
  const wrong = (env: AuthEnv) => login(env, { email: account.email, password: 'nope' }, req())

  it('starts holding the account back after five wrong guesses', async () => {
    const { env, user } = envWith()
    await signUpAndVerify(env)

    for (let i = 0; i < 4; i++) await wrong(env)
    expect(user().locked_until, 'four is not yet a pattern').toBeNull()

    await wrong(env)
    expect(user().failed_attempts).toBe(5)
    expect(user().locked_until).not.toBeNull()
  })

  it('doubles the wait each time the backoff is served and re-earned', async () => {
    const { env, raw, user } = envWith()
    await signUpAndVerify(env)
    for (let i = 0; i < 5; i++) await wrong(env)

    const waits: number[] = []
    for (let cycle = 0; cycle < 6; cycle++) {
      waits.push(Math.round((new Date(user().locked_until as string).getTime() - Date.now()) / 1000))
      raw.prepare(`UPDATE users SET locked_until = ?`).run(new Date(Date.now() - 1000).toISOString())
      await wrong(env)
    }

    expect(waits[0]).toBeGreaterThanOrEqual(59)
    expect(waits[1]).toBeGreaterThan(waits[0])
    expect(waits[2]).toBeGreaterThan(waits[1])
    // Capped: an unbounded doubling is a permanent lockout with extra steps.
    expect(Math.max(...waits)).toBeLessThanOrEqual(900)
    expect(waits.at(-1)).toBe(900)
  })

  it('does not let guesses during a backoff extend it', async () => {
    // Otherwise the backoff becomes the attack: keep guessing at someone
    // else's account and they are locked out forever, having done nothing.
    const { env, user } = envWith()
    await signUpAndVerify(env)
    for (let i = 0; i < 5; i++) await wrong(env)

    const lockedUntil = user().locked_until
    const attempts = user().failed_attempts
    for (let i = 0; i < 10; i++) await wrong(env)

    expect(user().locked_until).toBe(lockedUntil)
    expect(user().failed_attempts).toBe(attempts)
  })

  it('refuses a held-back account with the ordinary wrong-password answer', async () => {
    // Not a 429: a distinct status would announce "this address is registered"
    // to anyone willing to try five guesses.
    const { env } = envWith()
    await signUpAndVerify(env)
    for (let i = 0; i < 5; i++) await wrong(env)

    const held = await login(env, { email: account.email, password: account.password }, req())
    expect(held.status).toBe(401)
    expect(held.body).toEqual({ error: 'That email and password do not match.' })
  })

  it('clears the count the moment the right password arrives', async () => {
    const { env, user } = envWith()
    await signUpAndVerify(env)
    for (let i = 0; i < 3; i++) await wrong(env)
    expect(user().failed_attempts).toBe(3)

    await login(env, { email: account.email, password: account.password }, req())
    expect(user().failed_attempts).toBe(0)
    expect(user().locked_until).toBeNull()
  })

  it('counts nothing against an address with no account', async () => {
    const { env, user } = envWith()
    await signUpAndVerify(env)
    for (let i = 0; i < 8; i++) {
      await login(env, { email: 'nobody@example.com', password: 'nope' }, req())
    }
    expect(user().failed_attempts).toBe(0)
  })
})

/* --------------------------------------------------------------- sessions */

describe('sessions', () => {
  it('recognises the browser holding the cookie', async () => {
    const { env } = envWith()
    const token = tokenFrom(cookieFrom(await signUpAndVerify(env)))
    expect((await sessionUser(env, withCookie(`${SESSION_COOKIE}=${token}`)))?.email).toBe(
      'ada@example.com',
    )
  })

  it('is nobody without a cookie, or with one that was made up', async () => {
    const { env } = envWith()
    await signUpAndVerify(env)

    expect(await sessionUser(env, new Request('https://api.test/'))).toBeNull()
    expect(await sessionUser(env, withCookie(`${SESSION_COOKIE}=invented`))).toBeNull()
  })

  it('ends the session server-side, not just in the browser', async () => {
    const { env, sessions } = envWith()
    const token = tokenFrom(cookieFrom(await signUpAndVerify(env)))
    const request = withCookie(`${SESSION_COOKIE}=${token}`)

    await logout(env, request)
    expect(sessions()).toHaveLength(0)
    expect(await sessionUser(env, request)).toBeNull()
  })

  it('clears the cookie on the way out', async () => {
    const { env } = envWith()
    expect(cookieFrom(await logout(env, new Request('https://api.test/')))).toContain('Max-Age=0')
  })
})

describe('readCookie', () => {
  it('picks one cookie out of several', () => {
    expect(
      readCookie(withCookie(`other=1; ${SESSION_COOKIE}=abc123; another=2`), SESSION_COOKIE),
    ).toBe('abc123')
  })

  it('does not match a cookie whose name merely ends the same way', () => {
    expect(readCookie(withCookie(`not_${SESSION_COOKIE}=wrong`), SESSION_COOKIE)).toBe('')
  })

  it('returns empty when there are no cookies at all', () => {
    expect(readCookie(new Request('https://api.test/'), SESSION_COOKIE)).toBe('')
  })
})

/* --------------------------------------------------------- forgot password */

describe('asking for a reset link', () => {
  it('answers identically for an address with an account and one without', async () => {
    const { env } = envWith()
    await signUpAndVerify(env)

    const known = await requestPasswordReset(env, { email: account.email }, req())
    const unknown = await requestPasswordReset(env, { email: 'nobody@example.com' }, req())

    expect(unknown.status).toBe(known.status)
    expect(unknown.body).toEqual(known.body)
  })

  it('only actually sends to a confirmed account', async () => {
    const { env } = envWith()
    await signUpAndVerify(env)
    sent = []

    await requestPasswordReset(env, { email: account.email }, req())
    expect(sent[0].subject).toMatch(/reset/i)

    sent = []
    await requestPasswordReset(env, { email: 'nobody@example.com' }, req())
    expect(sent, 'nothing to send to an address with no account').toHaveLength(0)
  })

  it('sends nothing for an account that was never confirmed', async () => {
    const { env } = envWith()
    await register(env, account, req())
    sent = []

    expect((await requestPasswordReset(env, { email: account.email }, req())).status).toBe(200)
    expect(sent).toHaveLength(0)
  })

  it('replaces any earlier link rather than leaving two alive', async () => {
    const { env } = envWith()
    await signUpAndVerify(env)

    await requestPasswordReset(env, { email: account.email }, req())
    const first = linkFrom(sent.at(-1)!.text)
    await requestPasswordReset(env, { email: account.email }, req())
    const second = linkFrom(sent.at(-1)!.text)

    expect((await resetPassword(env, { token: first, password: 'a'.repeat(12) })).status).toBe(400)
    expect((await resetPassword(env, { token: second, password: 'a'.repeat(12) })).status).toBe(200)
  })

  it('is throttled, because it sends mail to an address a stranger chose', async () => {
    const { env } = envWith({ SIGNUP_LIMITER: { limit: async () => ({ success: false }) } })
    expect((await requestPasswordReset(env, { email: account.email }, req())).status).toBe(429)
  })
})

describe('using a reset link', () => {
  async function linkFor(env: AuthEnv) {
    await requestPasswordReset(env, { email: account.email }, req())
    return linkFrom(sent.at(-1)!.text)
  }

  it('sets the new password and signs them in', async () => {
    const { env } = envWith()
    await signUpAndVerify(env)
    const result = await resetPassword(env, {
      token: await linkFor(env),
      password: 'a brand new password',
    })

    expect(result.status).toBe(200)
    expect(cookieFrom(result)).toContain('HttpOnly')
    expect(
      (await login(env, { email: account.email, password: 'a brand new password' }, req())).status,
    ).toBe(200)
  })

  it('ends every other session, which is the point of resetting', async () => {
    const { env, sessions } = envWith()
    await signUpAndVerify(env)
    await login(env, { email: account.email, password: account.password }, req())
    expect(sessions().length).toBeGreaterThan(1)

    await resetPassword(env, { token: await linkFor(env), password: 'a brand new password' })
    // Exactly one: the device that just did the resetting.
    expect(sessions()).toHaveLength(1)
  })

  it('clears a backoff, so a reset is a way out of being held back', async () => {
    const { env, user } = envWith()
    await signUpAndVerify(env)
    for (let i = 0; i < 6; i++) await login(env, { email: account.email, password: 'no' }, req())
    expect(user().locked_until).not.toBeNull()

    await resetPassword(env, { token: await linkFor(env), password: 'a brand new password' })
    expect(user().failed_attempts).toBe(0)
    expect(user().locked_until).toBeNull()
  })

  it('refuses a new password that is already in a breach corpus', async () => {
    const { env } = envWith()
    await signUpAndVerify(env)
    await markBreached('Password1!')

    expect(
      (await resetPassword(env, { token: await linkFor(env), password: 'Password1!' })).status,
    ).toBe(400)
  })

  it('works once', async () => {
    const { env } = envWith()
    await signUpAndVerify(env)
    const token = await linkFor(env)

    expect((await resetPassword(env, { token, password: 'a brand new password' })).status).toBe(200)
    expect((await resetPassword(env, { token, password: 'another one entirely' })).status).toBe(400)
  })

  it('refuses an expired link', async () => {
    const { env, raw } = envWith()
    await signUpAndVerify(env)
    const token = await linkFor(env)
    raw
      .prepare(`UPDATE email_tokens SET expires_at = ? WHERE purpose = 'reset'`)
      .run(new Date(Date.now() - 1000).toISOString())

    expect((await resetPassword(env, { token, password: 'a brand new password' })).status).toBe(400)
  })

  it('will not accept a verification token in its place', async () => {
    // Different purposes, different lifetimes, different powers. A verify
    // token is a signup formality; a reset token is a live key to an account.
    const { env } = envWith()
    await register(env, account, req())
    expect(
      (await resetPassword(env, { token: linkFrom(sent[0].text), password: 'a'.repeat(12) })).status,
    ).toBe(400)
  })

  it('refuses a new password too short to be one', async () => {
    const { env } = envWith()
    await signUpAndVerify(env)
    expect((await resetPassword(env, { token: await linkFor(env), password: 'short' })).status).toBe(
      400,
    )
  })
})

/* ------------------------------------------------------- account settings */

describe('changing a password from the settings page', () => {
  it('needs the current one, because a live session is not the person', async () => {
    // An unlocked laptop is the whole attack. Re-asking costs a returning
    // owner four seconds and costs somebody who sat down at their desk
    // everything.
    const { env } = envWith()
    const { user } = await signedIn(env)

    expect(
      (await changePassword(env, user, { current: 'not it', next: 'a brand new password' })).status,
    ).toBe(401)
    expect(
      (await login(env, { email: account.email, password: account.password }, req())).status,
      'the old password still works',
    ).toBe(200)
  })

  it('changes it, and the new one is what signs in', async () => {
    const { env } = envWith()
    const { user } = await signedIn(env)

    expect(
      (await changePassword(env, user, { current: account.password, next: 'a brand new password' }))
        .status,
    ).toBe(200)
    expect(
      (await login(env, { email: account.email, password: 'a brand new password' }, req())).status,
    ).toBe(200)
    expect(
      (await login(env, { email: account.email, password: account.password }, req())).status,
    ).toBe(401)
  })

  it('leaves other sessions alone, unlike a reset', async () => {
    /*
     * The two look similar and mean different things. A reset is what somebody
     * does when they think another person has their password, so it ends
     * everything; this is routine hygiene from a signed-in device, and quietly
     * signing the owner out of their phone is an unpleasant surprise.
     */
    const { env, sessions } = envWith()
    const { user } = await signedIn(env)
    await login(env, { email: account.email, password: account.password }, req())
    const before = sessions().length

    await changePassword(env, user, { current: account.password, next: 'a brand new password' })
    expect(sessions()).toHaveLength(before)
  })

  it('refuses a new password that is already in a breach corpus', async () => {
    const { env } = envWith()
    const { user } = await signedIn(env)
    await markBreached('Password1!')

    expect(
      (await changePassword(env, user, { current: account.password, next: 'Password1!' })).status,
    ).toBe(400)
  })

  it('refuses one too short to be a password', async () => {
    const { env } = envWith()
    const { user } = await signedIn(env)
    expect(
      (await changePassword(env, user, { current: account.password, next: 'short' })).status,
    ).toBe(400)
  })
})

describe('changing the email on an account', () => {
  const NEW_ADDRESS = 'ada.lovelace@example.com'
  const other = { name: 'Someone', email: NEW_ADDRESS, password: 'another password here' }

  it('sends the link to the new address and changes nothing yet', async () => {
    const { env, user: row } = envWith()
    const { user } = await signedIn(env)
    sent = []

    const result = await requestEmailChange(
      env,
      user,
      { password: account.password, email: NEW_ADDRESS },
      req(),
    )

    expect(result.status).toBe(200)
    expect(sent[0].to, 'the point is to prove somebody reads the new one').toBe(NEW_ADDRESS)
    expect(row().email, 'the account keeps working on the old address').toBe(account.email)
    expect(row().pending_email).toBe(NEW_ADDRESS)
  })

  it('moves the account once the link is clicked', async () => {
    const { env, user: row } = envWith()
    const { user } = await signedIn(env)
    sent = []

    await requestEmailChange(env, user, { password: account.password, email: NEW_ADDRESS }, req())
    const result = await verifyEmail(env, { token: linkFrom(sent[0].text) })

    expect(result.status).toBe(200)
    expect(row().email).toBe(NEW_ADDRESS)
    expect(row().pending_email).toBeNull()
    expect(
      (await login(env, { email: NEW_ADDRESS, password: account.password }, req())).status,
    ).toBe(200)
  })

  it('needs the current password', async () => {
    const { env, user: row } = envWith()
    const { user } = await signedIn(env)
    expect(
      (await requestEmailChange(env, user, { password: 'not it', email: NEW_ADDRESS }, req())).status,
    ).toBe(401)
    expect(row().pending_email).toBeNull()
  })

  it('does not say whether the new address is already taken', async () => {
    /*
     * Reporting that on a settings form would turn it into the
     * account-existence oracle registration goes to such lengths to avoid —
     * and one that comes with free confirmation the asker is a real signed-in
     * customer. The collision is caught at redemption instead.
     */
    const { env } = envWith()
    const { user } = await signedIn(env)

    await register(env, other, req())
    await verifyEmail(env, { token: linkFrom(sent.at(-1)!.text) })

    const taken = await requestEmailChange(
      env,
      user,
      { password: account.password, email: NEW_ADDRESS },
      req(),
    )
    const free = await requestEmailChange(
      env,
      user,
      { password: account.password, email: 'nobody@example.com' },
      req(),
    )
    expect(taken.status).toBe(free.status)
  })

  it('refuses at redemption when the address was taken in the meantime', async () => {
    const { env, user: row } = envWith()
    const { user } = await signedIn(env)
    sent = []

    await requestEmailChange(env, user, { password: account.password, email: NEW_ADDRESS }, req())
    const link = linkFrom(sent[0].text)

    // Somebody else registers it before the link is clicked.
    await register(env, other, req())
    await verifyEmail(env, { token: linkFrom(sent.at(-1)!.text) })

    const result = await verifyEmail(env, { token: link })
    expect(result.status).toBe(409)
    expect(row().email, 'the account is unchanged').toBe(account.email)
  })

  it('refuses the address the account already has', async () => {
    const { env } = envWith()
    const { user } = await signedIn(env)
    expect(
      (
        await requestEmailChange(
          env,
          user,
          { password: account.password, email: account.email },
          req(),
        )
      ).status,
    ).toBe(400)
  })
})

describe('signing out other devices', () => {
  it('ends the others and keeps this one', async () => {
    const { env, sessions } = envWith()
    const { user, request } = await signedIn(env)
    await login(env, { email: account.email, password: account.password }, req())
    await login(env, { email: account.email, password: account.password }, req())
    expect(sessions()).toHaveLength(3)

    const result = await revokeOtherSessions(env, user, request)
    expect((result.body as { ended: number }).ended).toBe(2)
    expect(sessions()).toHaveLength(1)
    // Nobody wants to sign themselves out while pressing this.
    expect(await sessionUser(env, request)).not.toBeNull()
  })

  it('says so plainly when there were none', async () => {
    const { env } = envWith()
    const { user, request } = await signedIn(env)
    expect(((await revokeOtherSessions(env, user, request)).body as { ended: number }).ended).toBe(0)
  })
})

describe('closing an account', () => {
  it('needs the current password', async () => {
    const { env, users } = envWith()
    const { user } = await signedIn(env)
    expect((await deleteAccount(env, user, { password: 'not it' })).status).toBe(401)
    expect(users()).toHaveLength(1)
  })

  it('removes the account and everything attached to it', async () => {
    const { env, users, sessions, tokens } = envWith()
    const { user } = await signedIn(env)

    const result = await deleteAccount(env, user, { password: account.password })
    expect(result.status).toBe(200)
    expect(users()).toHaveLength(0)
    expect(sessions()).toHaveLength(0)
    expect(tokens()).toHaveLength(0)
    expect(cookieFrom(result)).toContain('Max-Age=0')
  })

  it('keeps the orders and unlinks them', async () => {
    /*
     * An order is the record of a transaction that happened, carrying the
     * address it shipped to and the price charged. Erasing it on request
     * erases the shop's side of that too. What goes is the link.
     */
    const { env, raw } = envWith()
    const { user } = await signedIn(env)
    raw
      .prepare(
        `INSERT INTO orders (id, email, ship_name, ship_line1, ship_city, ship_state, ship_postal,
                             method, subtotal_cents, shipping_cents, tax_cents, total_cents,
                             payment_status, user_id)
         VALUES ('NX-4K2P9','ada@example.com','Ada','1 St','Town','OR','97201','standard',
                 1000,0,0,1000,'succeeded',?)`,
      )
      .run(user.id)

    await deleteAccount(env, user, { password: account.password })

    const orders = raw.prepare(`SELECT id, user_id FROM orders`).all() as { user_id: string | null }[]
    expect(orders).toHaveLength(1)
    expect(orders[0].user_id).toBeNull()
  })
})

/* ---------------------------------------------------------- second factor */

describe('turning on a second factor', () => {
  async function enrol(env: AuthEnv, user: User) {
    const started = await startTotpEnrolment(env, user, { password: account.password })
    const { secret } = started.body as { secret: string }
    const confirmed = await confirmTotpEnrolment(env, user, { code: await totpCode(secret) })
    return { secret, confirmed }
  }

  it('needs the current password to start', async () => {
    const { env } = envWith()
    const { user } = await signedIn(env)
    expect((await startTotpEnrolment(env, user, { password: 'not it' })).status).toBe(401)
  })

  it('does not turn anything on until a real code arrives', async () => {
    /*
     * A secret that was generated and never successfully used must not be able
     * to lock somebody out of their own account — which is what would happen if
     * enrolment took effect at the first step and the app was never set up.
     */
    const { env, user: row } = envWith()
    const { user } = await signedIn(env)

    await startTotpEnrolment(env, user, { password: account.password })
    expect(row().totp_secret).not.toBeNull()
    expect(row().totp_confirmed_at, 'not on yet').toBeNull()
    expect(
      (await login(env, { email: account.email, password: account.password }, req())).status,
      'and signing in still works without a code',
    ).toBe(200)
  })

  it('refuses a wrong code and stays off', async () => {
    const { env, user: row } = envWith()
    const { user } = await signedIn(env)
    await startTotpEnrolment(env, user, { password: account.password })

    expect((await confirmTotpEnrolment(env, user, { code: '000000' })).status).toBe(400)
    expect(row().totp_confirmed_at).toBeNull()
  })

  it('turns on with a real code, and hands over recovery codes once', async () => {
    const { env, user: row, codes } = envWith()
    const { user } = await signedIn(env)
    const { confirmed } = await enrol(env, user)

    expect(confirmed.status).toBe(200)
    expect(row().totp_confirmed_at).not.toBeNull()

    const issued = (confirmed.body as { recoveryCodes: string[] }).recoveryCodes
    expect(issued).toHaveLength(8)
    // Stored as hashes, so nobody — including this service — can show them
    // again.
    expect(codes()).toHaveLength(8)
    expect(JSON.stringify(codes())).not.toContain(issued[0].replace('-', ''))
  })

  it('then asks for a code at sign-in', async () => {
    const { env } = envWith()
    const { user } = await signedIn(env)
    const { secret } = await enrol(env, user)

    const without = await login(env, { email: account.email, password: account.password }, req())
    expect(without.status).toBe(403)
    expect((without.body as { mfaRequired?: boolean }).mfaRequired).toBe(true)

    const withCode = await login(
      env,
      { email: account.email, password: account.password, code: await totpCode(secret) },
      req(),
    )
    expect(withCode.status).toBe(200)
  })

  it('refuses a wrong code at sign-in', async () => {
    const { env } = envWith()
    const { user } = await signedIn(env)
    await enrol(env, user)

    const result = await login(
      env,
      { email: account.email, password: account.password, code: '000000' },
      req(),
    )
    expect(result.status).toBe(401)
    expect((result.body as { mfaRequired?: boolean }).mfaRequired).toBe(true)
  })

  it('accepts a recovery code in the same field, once', async () => {
    // Somebody whose phone is gone is already having a bad day and should not
    // have to find a different form.
    const { env } = envWith()
    const { user } = await signedIn(env)
    const { confirmed } = await enrol(env, user)
    const [code] = (confirmed.body as { recoveryCodes: string[] }).recoveryCodes

    expect(
      (await login(env, { email: account.email, password: account.password, code }, req())).status,
    ).toBe(200)
    expect(
      (await login(env, { email: account.email, password: account.password, code }, req())).status,
      'a spent code is spent',
    ).toBe(401)
  })

  it('accepts a recovery code typed in lower case, without the dash', async () => {
    const { env } = envWith()
    const { user } = await signedIn(env)
    const { confirmed } = await enrol(env, user)
    const [code] = (confirmed.body as { recoveryCodes: string[] }).recoveryCodes

    expect(
      (
        await login(
          env,
          { email: account.email, password: account.password, code: code.toLowerCase().replace('-', '') },
          req(),
        )
      ).status,
    ).toBe(200)
  })

  it('turns off with the password, and takes the recovery codes with it', async () => {
    const { env, user: row, codes } = envWith()
    const { user } = await signedIn(env)
    await enrol(env, user)

    expect((await disableTotp(env, user, { password: 'not it' })).status).toBe(401)
    expect((await disableTotp(env, user, { password: account.password })).status).toBe(200)

    expect(row().totp_confirmed_at).toBeNull()
    expect(row().totp_secret).toBeNull()
    expect(codes(), 'stale codes must not outlive the factor').toHaveLength(0)
    expect(
      (await login(env, { email: account.email, password: account.password }, req())).status,
    ).toBe(200)
  })

  it('reports the state the settings page draws itself from', async () => {
    const { env } = envWith()
    const { user } = await signedIn(env)
    expect((await accountSettings(env, user)).twoFactor).toBe(false)

    await enrol(env, user)
    const settings = await accountSettings(env, user)
    expect(settings.twoFactor).toBe(true)
    expect(settings.recoveryCodesLeft).toBe(8)
    expect(settings.sessions).toBeGreaterThan(0)
  })
})

/* ----------------------------------------------------------------- hygiene */

describe('the nightly sweep', () => {
  it('deletes what has aged out and leaves what has not', async () => {
    const { env, raw, sessions, tokens } = envWith()
    await signUpAndVerify(env)

    const past = new Date(Date.now() - 1000).toISOString()
    raw
      .prepare(`INSERT INTO sessions (token_hash, user_id, expires_at) SELECT 'old', id, ? FROM users`)
      .run(past)
    raw
      .prepare(
        `INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at)
         SELECT 'old', id, 'verify', ? FROM users`,
      )
      .run(past)

    raw
      .prepare(
        `INSERT INTO staff (id, email, scope, merchant_id, role, password_hash, password_salt, iterations, kdf_rounds)
         VALUES ('stf_a', 'a@nexus.test', 'platform', NULL, 'admin', 'h', 's', 1, 1)`,
      )
      .run()
    const future = new Date(Date.now() + 3600_000).toISOString()
    raw
      .prepare(
        `INSERT INTO staff_sessions (token_hash, staff_id, expires_at, totp_pending)
         VALUES ('stale', 'stf_a', ?, 1), ('live', 'stf_a', ?, 0)`,
      )
      .run(past, future)

    const purged = await purgeExpired(env)

    expect(purged.sessions).toBe(1)
    expect(purged.tokens).toBe(1)
    expect(purged.staffSessions).toBe(1)
    expect(raw.prepare(`SELECT token_hash FROM staff_sessions`).all()).toEqual([{ token_hash: 'live' }])
    expect(sessions(), 'the live session survives').toHaveLength(1)
    expect(tokens().every((t) => t.token_hash !== 'old')).toBe(true)
  })

  it('keeps a spent link until it expires, so "already used" stays true', async () => {
    const { env, tokens } = envWith()
    await signUpAndVerify(env)

    await purgeExpired(env)
    expect(tokens().filter((t) => t.used_at !== null)).toHaveLength(1)
  })
})

describe('what /api/health reports', () => {
  it('says which protections are actually bound, not which exist in the code', () => {
    const { env } = envWith()
    expect(authDefences(env)).toEqual({
      mail: true,
      loginRateLimit: false,
      signupRateLimit: false,
      orderRateLimit: false,
      durableThrottle: false,
    })

    const wired = envWith({
      LOGIN_LIMITER: { limit: async () => ({ success: true }) },
      SIGNUP_LIMITER: { limit: async () => ({ success: true }) },
      IP_THROTTLE: {
        idFromName: () => ({}) as DurableObjectId,
        get: () => ({ fetch: async () => new Response() }),
      },
    })
    expect(authDefences(wired.env).loginRateLimit).toBe(true)
    // The one that matters most: without it the others are advisory, because
    // the platform limiter refused one request in twenty-five when measured.
    expect(authDefences(wired.env).durableThrottle).toBe(true)
    expect(authDefences({ ...env, RESEND_API_KEY: undefined }).mail).toBe(false)
  })
})

describe('the work factor', () => {
  it('stays at or under what the runtime will run in one call', async () => {
    // Workers refuses PBKDF2 above 100,000 outright. It was set to OWASP's
    // 210,000 first and every signup returned a 500 that said nothing.
    const { env, user } = envWith()
    await register(env, account, req())
    expect(user().iterations).toBeLessThanOrEqual(MAX_PBKDF2_ITERATIONS)
  })
})
