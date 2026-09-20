import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  register,
  login,
  logout,
  verifyEmail,
  sessionUser,
  readCookie,
  authDefences,
  SESSION_COOKIE,
  MAX_PBKDF2_ITERATIONS,
  type AuthEnv,
} from './auth'

/**
 * A notebook standing in for D1, same idea as the orders fake: what matters is
 * what gets written, not that a real database wrote it. It stores rows exactly
 * as handed over, which is the point — several of these tests are about what
 * is NOT in them.
 */
type Row = Record<string, unknown>

function fakeDb() {
  const users: Row[] = []
  const sessions: Row[] = []
  const tokens: Row[] = []

  const mutate = (sql: string, args: unknown[]) => {
    if (sql.includes('INSERT INTO users')) {
      const [id, email, name, password_hash, password_salt, iterations] = args
      if (users.some((u) => u.email === email)) {
        throw new Error('D1_ERROR: UNIQUE constraint failed: users.email')
      }
      users.push({
        id,
        email,
        name,
        password_hash,
        password_salt,
        iterations,
        failed_attempts: 0,
        locked_until: null,
        email_verified_at: null,
      })
    } else if (sql.includes('INSERT INTO sessions')) {
      const [token_hash, user_id, expires_at] = args
      sessions.push({ token_hash, user_id, expires_at })
    } else if (sql.includes('INSERT INTO email_tokens')) {
      const [token_hash, user_id, expires_at] = args
      tokens.push({ token_hash, user_id, purpose: 'verify', expires_at, used_at: null })
    } else if (sql.includes('DELETE FROM sessions')) {
      const i = sessions.findIndex((s) => s.token_hash === args[0])
      if (i >= 0) sessions.splice(i, 1)
    } else if (sql.includes('DELETE FROM email_tokens WHERE user_id')) {
      for (let i = tokens.length - 1; i >= 0; i--) {
        if (tokens[i].user_id === args[0]) tokens.splice(i, 1)
      }
    } else if (sql.includes('DELETE FROM users WHERE id')) {
      const i = users.findIndex((u) => u.id === args[0])
      if (i >= 0) users.splice(i, 1)
    } else if (sql.includes('UPDATE email_tokens SET used_at')) {
      const token = tokens.find((t) => t.token_hash === args[0])
      if (token) token.used_at = args[1]
    } else if (sql.includes('UPDATE users SET email_verified_at')) {
      const user = users.find((u) => u.id === args[0])
      if (user) user.email_verified_at = args[1]
    } else if (sql.includes('UPDATE users SET failed_attempts = ?2')) {
      const user = users.find((u) => u.id === args[0])
      if (user) {
        user.failed_attempts = args[1]
        user.locked_until = args[2]
      }
    } else if (sql.includes('UPDATE users SET failed_attempts = 0')) {
      const user = users.find((u) => u.id === args[0])
      if (user) {
        user.failed_attempts = 0
        user.locked_until = null
      }
    }
    return {}
  }

  const query = (sql: string, args: unknown[]) => {
    if (sql.includes('FROM users WHERE email')) {
      return users.find((u) => u.email === args[0]) ?? null
    }
    if (sql.includes('FROM sessions s JOIN users u')) {
      const session = sessions.find((s) => s.token_hash === args[0])
      if (!session) return null
      const user = users.find((u) => u.id === session.user_id)!
      return { ...user, expires_at: session.expires_at }
    }
    if (sql.includes('FROM email_tokens t JOIN users u')) {
      const token = tokens.find((t) => t.token_hash === args[0])
      if (!token) return null
      const user = users.find((u) => u.id === token.user_id)!
      return { ...token, email: user.email, name: user.name }
    }
    return null
  }

  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            sql,
            args,
            async run() {
              return mutate(sql, args)
            },
            async first() {
              return query(sql, args)
            },
          }
        },
      }
    },
    async batch(stmts: { sql: string; args: unknown[] }[]) {
      // D1 batches are atomic; a throw here leaves nothing written, which is
      // what the duplicate-registration path relies on.
      for (const s of stmts) mutate(s.sql, s.args)
      return []
    },
  }

  return { db: db as unknown as D1Database, users, sessions, tokens }
}

/* ------------------------------------------------------------------- mail */

/** Every message the code tried to send, as the provider would have seen it. */
let sent: { to: string; subject: string; text: string }[] = []

beforeEach(() => {
  sent = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { to: string[]; subject: string; text: string }
      sent.push({ to: body.to[0], subject: body.subject, text: body.text })
      return new Response('{}', { status: 200 })
    }),
  )
})

afterEach(() => vi.unstubAllGlobals())

/** Makes the stubbed provider refuse, the way an unverified domain does. */
function refuseSends() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{"message":"You can only send to your own address"}', { status: 403 })),
  )
}

function envWith(over: Partial<AuthEnv> = {}) {
  const { db, users, sessions, tokens } = fakeDb()
  const env: AuthEnv = {
    ORDERS: db,
    RESEND_API_KEY: 'test-key',
    MAIL_FROM: 'NEXUS <test@example.com>',
    ALLOWED_ORIGIN: 'https://shop.example',
    ...over,
  }
  return { env, users, sessions, tokens }
}

const req = (headers: Record<string, string> = {}) =>
  new Request('https://api.test/', { headers: { 'cf-connecting-ip': '198.51.100.7', ...headers } })

const withCookie = (cookie: string) => new Request('https://api.test/', { headers: { cookie } })

const tokenFrom = (cookie: string) => cookie.slice(cookie.indexOf('=') + 1, cookie.indexOf(';'))

/** Pulls the one-shot code out of whatever link the email carried. */
const linkTokenFrom = (text: string) =>
  new URL(text.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!

const account = { name: 'Ada Lovelace', email: 'ada@example.com', password: 'correct horse battery' }

/** Registers and clicks the link, which is how an account becomes usable. */
async function signUpAndVerify(env: AuthEnv) {
  await register(env, account, req())
  return verifyEmail(env, { token: linkTokenFrom(sent[0].text) })
}

/* --------------------------------------------------------------- register */

describe('register', () => {
  it('creates the account but does not sign anyone in yet', async () => {
    const { env, users, sessions } = envWith()
    const result = await register(env, account, req())

    expect(result.status).toBe(200)
    expect(users).toHaveLength(1)
    // No session: the address has been typed, not proven.
    expect(sessions).toHaveLength(0)
    expect(users[0].email_verified_at).toBeNull()
    expect(users[0].email).toBe('ada@example.com')
  })

  it('answers identically whether or not the address is already taken', async () => {
    /*
     * The whole point of the verification flow. A different status, a
     * different message or even a different shape here is a free oracle for
     * "does this person shop at NEXUS", one address at a time.
     */
    const { env } = envWith()
    const first = await register(env, account, req())
    const second = await register(env, { ...account, name: 'Someone Else' }, req())

    expect(second.status).toBe(first.status)
    expect(second.body).toEqual(first.body)
  })

  it('tells the difference only to the inbox that owns the address', async () => {
    const { env, users } = envWith()
    await register(env, account, req())
    await register(env, account, req())

    expect(users, 'no second account').toHaveLength(1)
    expect(sent).toHaveLength(2)
    expect(sent[0].subject).toMatch(/confirm/i)
    // The owner hears about the attempt; whoever typed it gets the same page.
    expect(sent[1].subject).toMatch(/someone tried/i)
    expect(sent[1].text).not.toContain(account.password)
  })

  it('refuses to register at all when it cannot send email', async () => {
    /*
     * Fails closed. Without a channel to the address there is no flow that
     * both works and stays quiet about who is registered, and quietly
     * reverting to the loud one would lose the property while looking fine.
     */
    const { env, users } = envWith({ RESEND_API_KEY: undefined })
    const result = await register(env, account, req())

    expect(result.status).toBe(503)
    expect(users).toHaveLength(0)
  })

  it('never stores the password, and never stores the raw link token', async () => {
    const { env, users, tokens } = envWith()
    await register(env, account, req())

    const written = JSON.stringify({ users, tokens })
    expect(written).not.toContain(account.password)
    expect(written, 'the tokens table holds a hash, not the link').not.toContain(
      linkTokenFrom(sent[0].text),
    )
  })

  it('refuses a password too short to be one, and an address that is not one', async () => {
    const { env, users } = envWith()
    expect((await register(env, { ...account, password: 'short' }, req())).status).toBe(400)
    expect((await register(env, { ...account, email: 'ada' }, req())).status).toBe(400)
    expect(users).toHaveLength(0)
  })


  it('does not claim to have sent an email it could not send', async () => {
    /*
     * Found with no sending domain, which is what an unverified provider
     * account gives you: every send is refused and the return value was
     * ignored. The shopper was told "check your email" and refreshed an inbox
     * that would never receive anything.
     */
    const { env, users } = envWith()
    refuseSends()

    const result = await register(env, account, req())
    expect(result.status).toBe(503)
    expect((result.body as { error: string }).error).toMatch(/could not send/i)

    /*
     * And the half-made account is undone. Left behind, the address is taken:
     * trying again hits the unique constraint, so the shopper is locked out of
     * their own email address by a message they never got.
     */
    expect(users).toHaveLength(0)
  })

  it('lets a retry succeed once the transport works again', async () => {
    const { env, users } = envWith()
    refuseSends()
    await register(env, account, req())
    expect(users).toHaveLength(0)

    // Transport restored by the ordinary beforeEach stub.
    sent = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { to: string[]; subject: string; text: string }
        sent.push({ to: body.to[0], subject: body.subject, text: body.text })
        return new Response('{}', { status: 200 })
      }),
    )

    expect((await register(env, account, req())).status).toBe(200)
    expect(users).toHaveLength(1)
  })

  it('says the same thing about an undeliverable new address and an existing one', async () => {
    // The failure belongs to the recipient, not to the account, so it must not
    // become a way to tell the two apart.
    const { env } = envWith()
    await register(env, account, req())
    refuseSends()

    const taken = await register(env, account, req())
    const fresh = await register(env, { ...account, email: 'someone@example.com' }, req())
    expect(fresh.status).toBe(taken.status)
    expect(fresh.body).toEqual(taken.body)
  })

  it('refuses when the signup limiter says so, before touching anything', async () => {
    const { env, users } = envWith({ SIGNUP_LIMITER: { limit: async () => ({ success: false }) } })
    const result = await register(env, account, req())

    expect(result.status).toBe(429)
    expect(users).toHaveLength(0)
    expect(sent).toHaveLength(0)
  })
})

/* ----------------------------------------------------------------- verify */

describe('verifying an email', () => {
  it('confirms the address and signs them in', async () => {
    const { env, users, sessions } = envWith()
    const result = await signUpAndVerify(env)

    expect(result.status).toBe(200)
    expect(users[0].email_verified_at).not.toBeNull()
    expect(sessions).toHaveLength(1)
    expect((result as { cookie: string }).cookie).toContain('HttpOnly')
  })

  it('will not accept the same link twice', async () => {
    // A link that survives its first use is one a mail gateway, a browser
    // history or a forwarded message can replay.
    const { env } = envWith()
    await register(env, account, req())
    const token = linkTokenFrom(sent[0].text)

    expect((await verifyEmail(env, { token })).status).toBe(200)
    expect((await verifyEmail(env, { token })).status).toBe(400)
  })

  it('refuses an expired link', async () => {
    const { env, tokens } = envWith()
    await register(env, account, req())
    tokens[0].expires_at = new Date(Date.now() - 1000).toISOString()

    expect((await verifyEmail(env, { token: linkTokenFrom(sent[0].text) })).status).toBe(400)
  })

  it('says the same thing about unknown, expired and spent links', async () => {
    // All three mean "ask for another one", and telling them apart hands
    // someone holding a guessed token the news that they guessed correctly.
    const { env } = envWith()
    await register(env, account, req())
    const token = linkTokenFrom(sent[0].text)
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
    // Safe to be specific here: this branch is only reachable by someone who
    // already has the password.
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
    const { env, users } = envWith()
    await signUpAndVerify(env)

    for (let i = 0; i < 4; i++) await wrong(env)
    expect(users[0].locked_until, 'four is not yet a pattern').toBeNull()

    await wrong(env)
    expect(users[0].failed_attempts).toBe(5)
    expect(users[0].locked_until).not.toBeNull()
  })

  it('doubles the wait each time the backoff is served and re-earned', async () => {
    /*
     * The escalation only happens across lock cycles, because guesses made
     * while the account is held back are refused without counting (see the
     * test below for why). So waiting it out is simulated here rather than
     * hammering, which is what a patient attacker would actually do.
     */
    const { env, users } = envWith()
    await signUpAndVerify(env)
    for (let i = 0; i < 5; i++) await wrong(env)

    const waits: number[] = []
    for (let cycle = 0; cycle < 6; cycle++) {
      waits.push(
        Math.round((new Date(users[0].locked_until as string).getTime() - Date.now()) / 1000),
      )
      users[0].locked_until = new Date(Date.now() - 1000).toISOString() // the wait elapses
      await wrong(env)
    }

    expect(waits[0]).toBeGreaterThanOrEqual(59)
    expect(waits[1]).toBeGreaterThan(waits[0])
    expect(waits[2]).toBeGreaterThan(waits[1])
    // Capped, because an unbounded doubling is a permanent lockout with extra
    // steps — and a way for a stranger to take an account away from its owner.
    expect(Math.max(...waits)).toBeLessThanOrEqual(900)
    expect(waits.at(-1)).toBe(900)
  })

  it('does not let guesses during a backoff extend it', async () => {
    /*
     * Otherwise the backoff becomes the attack: keep guessing against someone
     * else's account and they are locked out forever, having done nothing.
     * Refusing without counting also means those attempts cost nothing to
     * serve, which is the other half of the point.
     */
    const { env, users } = envWith()
    await signUpAndVerify(env)
    for (let i = 0; i < 5; i++) await wrong(env)

    const lockedUntil = users[0].locked_until
    const attempts = users[0].failed_attempts
    for (let i = 0; i < 20; i++) await wrong(env)

    expect(users[0].locked_until).toBe(lockedUntil)
    expect(users[0].failed_attempts).toBe(attempts)
  })

  it('refuses a held-back account with the ordinary wrong-password answer', async () => {
    /*
     * Not a 429. A distinct status here would announce "this address is
     * registered" to anyone willing to try five guesses, which is exactly what
     * the registration flow goes to such lengths to avoid. Someone genuinely
     * fumbling their own password hits the per-IP limit first and gets a 429
     * that explains itself; the distributed attacker this branch exists for
     * gets nothing to read.
     */
    const { env } = envWith()
    await signUpAndVerify(env)
    for (let i = 0; i < 5; i++) await wrong(env)

    const held = await login(env, { email: account.email, password: account.password }, req())
    expect(held.status).toBe(401)
    expect(held.body).toEqual({ error: 'That email and password do not match.' })
  })

  it('clears the count the moment the right password arrives', async () => {
    // Backoff slows guessing; it does not punish someone who remembered.
    const { env, users } = envWith()
    await signUpAndVerify(env)
    for (let i = 0; i < 3; i++) await wrong(env)
    expect(users[0].failed_attempts).toBe(3)

    await login(env, { email: account.email, password: account.password }, req())
    expect(users[0].failed_attempts).toBe(0)
    expect(users[0].locked_until).toBeNull()
  })

  it('counts nothing against an address with no account', async () => {
    const { env, users } = envWith()
    await signUpAndVerify(env)
    for (let i = 0; i < 8; i++) {
      await login(env, { email: 'nobody@example.com', password: 'nope' }, req())
    }
    expect(users[0].failed_attempts).toBe(0)
  })
})

/* --------------------------------------------------------------- sessions */

describe('sessions', () => {
  it('recognises the browser holding the cookie', async () => {
    const { env } = envWith()
    const result = await signUpAndVerify(env)
    const token = tokenFrom((result as { cookie: string }).cookie)

    const user = await sessionUser(env, withCookie(`${SESSION_COOKIE}=${token}`))
    expect(user?.email).toBe('ada@example.com')
  })

  it('is nobody without a cookie, or with one that was made up', async () => {
    const { env } = envWith()
    await signUpAndVerify(env)

    expect(await sessionUser(env, new Request('https://api.test/'))).toBeNull()
    expect(await sessionUser(env, withCookie(`${SESSION_COOKIE}=invented`))).toBeNull()
  })

  it('ends the session server-side, not just in the browser', async () => {
    const { env, sessions } = envWith()
    const result = await signUpAndVerify(env)
    const token = tokenFrom((result as { cookie: string }).cookie)
    const request = withCookie(`${SESSION_COOKIE}=${token}`)

    await logout(env, request)
    expect(sessions).toHaveLength(0)
    expect(await sessionUser(env, request)).toBeNull()
  })

  it('clears the cookie on the way out', async () => {
    const { env } = envWith()
    const result = await logout(env, new Request('https://api.test/'))
    expect((result as { cookie: string }).cookie).toContain('Max-Age=0')
  })
})

describe('readCookie', () => {
  it('picks one cookie out of several', () => {
    expect(
      readCookie(withCookie(`other=1; ${SESSION_COOKIE}=abc123; another=2`), SESSION_COOKIE),
    ).toBe('abc123')
  })

  it('does not match a cookie whose name merely ends the same way', () => {
    // `not_nexus_session` contains the name; a sloppy `includes` would take it.
    expect(readCookie(withCookie(`not_${SESSION_COOKIE}=wrong`), SESSION_COOKIE)).toBe('')
  })

  it('returns empty when there are no cookies at all', () => {
    expect(readCookie(new Request('https://api.test/'), SESSION_COOKIE)).toBe('')
  })
})

describe('what /api/health reports', () => {
  it('says which protections are actually bound, not which exist in the code', () => {
    /*
     * An unbound rate limiter allows everything and looks exactly like a
     * working one from outside. A missing mail transport closes registration
     * and looks like a broken endpoint. Both need saying out loud.
     */
    const { env } = envWith()
    expect(authDefences(env)).toEqual({
      mail: true,
      loginRateLimit: false,
      signupRateLimit: false,
      durableThrottle: false,
    })

    const wired = envWith({
      LOGIN_LIMITER: { limit: async () => ({ success: true }) },
      SIGNUP_LIMITER: { limit: async () => ({ success: true }) },
      IP_THROTTLE: { idFromName: () => ({}) as DurableObjectId, get: () => ({ fetch: async () => new Response() }) },
    })
    expect(authDefences(wired.env).loginRateLimit).toBe(true)
    // The one that matters most: without it the others are advisory, because
    // the platform limiter refused one request in twenty-five when measured.
    expect(authDefences(wired.env).durableThrottle).toBe(true)
    expect(authDefences({ ...env, RESEND_API_KEY: undefined }).mail).toBe(false)
  })
})

describe('the iteration count', () => {
  it('stays at or under what the runtime will actually run', async () => {
    /*
     * Workers refuses PBKDF2 above 100,000 outright — not slowly, not with a
     * CPU warning, but `NotSupportedError: iteration counts above 100000 are
     * not supported`. It was set to OWASP's 210,000 first and every signup
     * returned a 500 that said nothing about why.
     */
    const { env, users } = envWith()
    await register(env, account, req())
    expect(users[0].iterations).toBeLessThanOrEqual(MAX_PBKDF2_ITERATIONS)
  })
})
