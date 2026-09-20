import { describe, it, expect } from 'vitest'
import {
  register,
  login,
  logout,
  sessionUser,
  readCookie,
  SESSION_COOKIE,
  MAX_PBKDF2_ITERATIONS,
} from './auth'

/**
 * A notebook standing in for D1, same idea as the orders fake: what matters is
 * what gets written, not that a real database wrote it. It stores rows exactly
 * as handed over, which is the point — these tests are mostly about what is
 * NOT in them.
 */
function fakeDb() {
  const users: Record<string, string | number>[] = []
  const sessions: Record<string, string>[] = []

  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              if (sql.includes('INSERT INTO users')) {
                const [id, email, name, password_hash, password_salt, iterations] = args as [
                  string, string, string, string, string, number,
                ]
                if (users.some((u) => u.email === email)) {
                  throw new Error('D1_ERROR: UNIQUE constraint failed: users.email')
                }
                users.push({ id, email, name, password_hash, password_salt, iterations })
              }
              if (sql.includes('INSERT INTO sessions')) {
                const [token_hash, user_id, expires_at] = args as [string, string, string]
                sessions.push({ token_hash, user_id, expires_at })
              }
              if (sql.includes('DELETE FROM sessions')) {
                const i = sessions.findIndex((s) => s.token_hash === args[0])
                if (i >= 0) sessions.splice(i, 1)
              }
              return {}
            },
            async first() {
              if (sql.includes('FROM users WHERE email')) {
                return users.find((u) => u.email === args[0]) ?? null
              }
              if (sql.includes('FROM sessions s JOIN users u')) {
                const session = sessions.find((s) => s.token_hash === args[0])
                if (!session) return null
                const user = users.find((u) => u.id === session.user_id)!
                return { ...user, expires_at: session.expires_at }
              }
              return null
            },
          }
        },
      }
    },
  }

  return { env: { ORDERS: db as unknown as D1Database }, users, sessions }
}

const withCookie = (cookie: string) =>
  new Request('https://api.test/api/auth/me', { headers: { cookie } })

/** Pulls the token back out of a Set-Cookie line, the way a browser would. */
const tokenFrom = (cookie: string) => cookie.slice(cookie.indexOf('=') + 1, cookie.indexOf(';'))

describe('register', () => {
  it('creates an account and starts a session', async () => {
    const { env, users, sessions } = fakeDb()
    const result = await register(env, {
      name: 'Ada Lovelace',
      email: 'Ada@Example.com',
      password: 'correct horse battery',
    })

    expect(result.status).toBe(200)
    expect(users).toHaveLength(1)
    expect(sessions).toHaveLength(1)
    // Lower-cased on the way in, so one address cannot become two accounts.
    expect(users[0].email).toBe('ada@example.com')
  })

  it('never stores the password, and never stores the session token', async () => {
    /*
     * The test this file exists for.
     *
     * A password in the users table is a breach waiting for someone else's
     * mistake, and a session token in the sessions table is a set of working
     * keys rather than a list of hashes. Both are checked by looking for the
     * secret in everything that was written.
     */
    const { env, users, sessions } = fakeDb()
    const password = 'correct horse battery'
    const result = await register(env, { name: 'Ada', email: 'ada@example.com', password })
    expect(result.status).toBe(200)

    const written = JSON.stringify({ users, sessions })
    expect(written).not.toContain(password)

    const token = tokenFrom((result as { cookie: string }).cookie)
    expect(token.length).toBeGreaterThan(20)
    expect(written, 'the sessions table must hold a hash, not the cookie').not.toContain(token)
  })

  it('sets a cookie the page itself cannot read', async () => {
    const { env } = fakeDb()
    const result = await register(env, { name: 'Ada', email: 'ada@example.com', password: 'a'.repeat(12) })
    const cookie = (result as { cookie: string }).cookie

    // HttpOnly is what stops an injected script lifting the session; the rest
    // keeps it off plaintext connections and off other sites' requests.
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Lax')
  })

  it('refuses a second account on the same email', async () => {
    const { env } = fakeDb()
    const body = { name: 'Ada', email: 'ada@example.com', password: 'a'.repeat(12) }
    expect((await register(env, body)).status).toBe(200)
    expect((await register(env, body)).status).toBe(409)
  })

  it('refuses a password too short to be one', async () => {
    const { env, users } = fakeDb()
    const res = await register(env, { name: 'Ada', email: 'ada@example.com', password: 'short' })
    expect(res.status).toBe(400)
    expect(users).toHaveLength(0)
  })

  it('refuses an address that is not one', async () => {
    const { env } = fakeDb()
    expect((await register(env, { name: 'Ada', email: 'ada', password: 'a'.repeat(12) })).status).toBe(400)
  })
})

describe('login', () => {
  const account = { name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' }

  it('accepts the right password and issues a fresh session', async () => {
    const { env, sessions } = fakeDb()
    await register(env, account)

    const result = await login(env, { email: account.email, password: account.password })
    expect(result.status).toBe(200)
    expect(sessions).toHaveLength(2)
  })

  it('refuses the wrong password', async () => {
    const { env } = fakeDb()
    await register(env, account)
    expect((await login(env, { email: account.email, password: 'wrong one' })).status).toBe(401)
  })

  it('says exactly the same thing about a wrong password and an unknown account', async () => {
    // Two different messages here is a way to ask this endpoint who shops
    // here, one address at a time.
    const { env } = fakeDb()
    await register(env, account)

    const wrong = await login(env, { email: account.email, password: 'wrong one' })
    const unknown = await login(env, { email: 'nobody@example.com', password: 'wrong one' })

    expect(unknown.status).toBe(wrong.status)
    expect(unknown.body).toEqual(wrong.body)
  })

  it('finds the account however the email was capitalised', async () => {
    const { env } = fakeDb()
    await register(env, account)
    expect((await login(env, { email: 'ADA@Example.com', password: account.password })).status).toBe(200)
  })
})

describe('sessions', () => {
  const account = { name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' }

  it('recognises the browser holding the cookie', async () => {
    const { env } = fakeDb()
    const result = await register(env, account)
    const token = tokenFrom((result as { cookie: string }).cookie)

    const user = await sessionUser(env, withCookie(`${SESSION_COOKIE}=${token}`))
    expect(user?.email).toBe('ada@example.com')
  })

  it('is nobody without a cookie, or with one that was made up', async () => {
    const { env } = fakeDb()
    await register(env, account)

    expect(await sessionUser(env, new Request('https://api.test/'))).toBeNull()
    expect(await sessionUser(env, withCookie(`${SESSION_COOKIE}=invented`))).toBeNull()
  })

  it('ends the session server-side, not just in the browser', async () => {
    /*
     * Clearing the cookie alone would leave a token that still works if it was
     * ever captured — which is the case signing out on a shared machine is
     * meant to cover.
     */
    const { env, sessions } = fakeDb()
    const result = await register(env, account)
    const token = tokenFrom((result as { cookie: string }).cookie)
    const request = withCookie(`${SESSION_COOKIE}=${token}`)

    await logout(env, request)
    expect(sessions).toHaveLength(0)
    expect(await sessionUser(env, request)).toBeNull()
  })

  it('clears the cookie on the way out', async () => {
    const { env } = fakeDb()
    const result = await logout(env, new Request('https://api.test/'))
    expect((result as { cookie: string }).cookie).toContain('Max-Age=0')
  })
})

describe('readCookie', () => {
  it('picks one cookie out of several', () => {
    const request = withCookie(`other=1; ${SESSION_COOKIE}=abc123; another=2`)
    expect(readCookie(request, SESSION_COOKIE)).toBe('abc123')
  })

  it('does not match a cookie whose name merely ends the same way', () => {
    // `not_nexus_session` contains the name; a sloppy `includes` would take it.
    const request = withCookie(`not_${SESSION_COOKIE}=wrong`)
    expect(readCookie(request, SESSION_COOKIE)).toBe('')
  })

  it('returns empty when there are no cookies at all', () => {
    expect(readCookie(new Request('https://api.test/'), SESSION_COOKIE)).toBe('')
  })
})

describe('the iteration count', () => {
  it('stays at or under what the runtime will actually run', async () => {
    /*
     * Workers refuses PBKDF2 above 100,000 outright — not slowly, not with a
     * CPU warning, but `NotSupportedError: iteration counts above 100000 are
     * not supported`. It was set to OWASP's 210,000 first and every signup
     * returned a 500 that said nothing about why.
     *
     * The count is written onto each row, so this reads it back from a real
     * registration rather than from the constant it is asserting about.
     */
    const { env, users } = fakeDb()
    const res = await register(env, { name: 'Ada', email: 'ada@example.com', password: 'a'.repeat(12) })
    expect(res.status).toBe(200)
    expect(users[0].iterations).toBeLessThanOrEqual(MAX_PBKDF2_ITERATIONS)
  })
})
