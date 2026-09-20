/**
 * Accounts and sessions.
 *
 * An account here buys exactly one thing: the orders you placed while signed
 * in, readable from any device. That is deliberately narrow. The cart and the
 * comparison stay on the device, because they are better there — nobody wants
 * yesterday's phone basket following them onto a work laptop.
 *
 * Four decisions worth knowing about:
 *
 * 1. Orders are linked to an account by `user_id` at the moment they are
 *    placed, never by matching email. An email join would hand a stranger a
 *    real customer's address and order history for the price of a signup.
 *
 * 2. The session cookie is HttpOnly. The token never touches JavaScript, so a
 *    script injected into the storefront cannot read it. What is stored is the
 *    SHA-256 of the token, not the token, so a dump of the sessions table is a
 *    list of hashes rather than a set of working keys.
 *
 * 3. Registration answers identically whether or not the address is taken.
 *    Which one happened is told only to the inbox that owns the address. This
 *    is why a mail transport is a hard requirement rather than a nicety — see
 *    `mailerFor` returning null, and this module refusing to register without
 *    one.
 *
 * 4. Guessing is throttled in three places, because they catch different
 *    attacks. Cloudflare's own limiter is cheap and turns most of a flood
 *    away, but it is per-isolate and measurably lossy. A Durable Object behind
 *    it keeps the count that can be trusted, per IP. And per-account backoff
 *    catches what no per-IP limit can see: a thousand machines taking turns on
 *    one account, none of them often enough to trip a limit of their own.
 */
import type { OrdersEnv } from './orders'
import { mailerFor, verificationEmail, alreadyRegisteredEmail, type MailEnv } from './mail'
import { throttle, type ThrottleBinding } from './throttle'

/** Cloudflare's rate limiting binding. Absent in tests and local dev. */
export interface RateLimiterBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

export interface AuthEnv extends OrdersEnv, MailEnv {
  /** Cloudflare's own limiter: cheap, in front, and best-effort. */
  LOGIN_LIMITER?: RateLimiterBinding
  SIGNUP_LIMITER?: RateLimiterBinding
  /** The Durable Object behind it, which is the one that actually counts. */
  IP_THROTTLE?: ThrottleBinding
  /** Comma-separated; the first entry is the canonical storefront. */
  ALLOWED_ORIGIN?: string
}

/**
 * Per-IP budgets.
 *
 * Signing up is rarer than signing in and costs an email, so it gets less
 * room. Both are generous enough that a person who has genuinely forgotten
 * their password never meets them.
 */
const LOGIN_PER_MINUTE = 10
const SIGNUP_PER_MINUTE = 5

/* --------------------------------------------------------------- primitives */

const encoder = new TextEncoder()

const toB64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes))
const fromB64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))

/** URL-safe, because these travel in a link people click out of an email. */
const toB64Url = (bytes: Uint8Array): string =>
  toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/**
 * PBKDF2-HMAC-SHA256, at the highest iteration count this runtime allows.
 *
 * Not bcrypt or argon2: neither exists in the Workers runtime, and shipping a
 * WASM build of one to hash a demo store's passwords is a larger risk surface
 * than the thing it protects. PBKDF2 is the strongest primitive available here
 * natively, which makes the iteration count the only real dial.
 *
 * And the dial does not go as far as it should. Workers refuses outright above
 * 100,000 — `NotSupportedError: Pbkdf2 failed: iteration counts above 100000
 * are not supported` — which is below OWASP's current guidance for this
 * algorithm. There is no configuration for it; it is the platform's ceiling.
 *
 * ponytail: 100k because the runtime rejects more. Real protection at this
 * point means a different KDF, which on Workers means WASM — worth it for
 * credentials that matter, not for a demo store that tells people not to reuse
 * a password. The count is stored per user, so the day that changes, everyone
 * is re-hashed as they sign in rather than locked out.
 */
const PBKDF2_ITERATIONS = 100_000

/** What the runtime will accept. Above this, `deriveBits` throws. */
export const MAX_PBKDF2_ITERATIONS = 100_000

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256,
  )
  return new Uint8Array(bits)
}

/**
 * Comparison that takes the same time whatever the answer.
 *
 * `a === b` on secrets leaks their contents one byte at a time to anyone
 * willing to measure, and the measurement is not exotic.
 */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text))
  return toB64(new Uint8Array(digest))
}

const randomB64 = (bytes: number): string => toB64(crypto.getRandomValues(new Uint8Array(bytes)))
const randomToken = (): string => toB64Url(crypto.getRandomValues(new Uint8Array(32)))

const nowIso = () => new Date().toISOString()
const inSeconds = (s: number) => new Date(Date.now() + s * 1000).toISOString()
const isPast = (iso: string | null | undefined) =>
  Boolean(iso) && new Date(iso as string).getTime() < Date.now()

/* ------------------------------------------------------------------ cookies */

export const SESSION_COOKIE = 'nexus_session'
const SESSION_DAYS = 30

/**
 * The site and this API are different origins but the same site — both sit
 * under one registrable domain — so `Lax` is enough and the cookie is not a
 * third-party one that browsers are busy phasing out.
 */
function sessionCookie(token: string, maxAgeSeconds: number): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ')
}

export function readCookie(request: Request, name: string): string {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return ''
}

/* ------------------------------------------------------------- rate limiting */

const clientIp = (request: Request): string =>
  request.headers.get('cf-connecting-ip') ?? request.headers.get('x-real-ip') ?? 'unknown'

/**
 * True when the caller may proceed.
 *
 * An absent binding allows everything, which is correct for tests and local
 * dev and wrong everywhere else — so `/api/health` reports whether the
 * limiters are actually bound rather than leaving it to be discovered.
 */
async function withinLimit(limiter: RateLimiterBinding | undefined, key: string): Promise<boolean> {
  if (!limiter) return true
  try {
    return (await limiter.limit({ key })).success
  } catch (err) {
    // A limiter that errors must not become a way to bypass it, but it must
    // also not take the service down. Logged loudly, fails open.
    console.error('rate limiter unavailable', err)
    return true
  }
}

/**
 * Both throttles, cheap one first.
 *
 * The platform limiter costs nothing and turns most of a flood away. What gets
 * past it meets the Durable Object, which is single-threaded per key and
 * therefore the one whose count can be trusted — measured, not assumed:
 * twenty-five parallel requests against a 5-per-minute platform limit produced
 * one refusal, because each isolate was keeping its own tally.
 */
async function guard(
  env: AuthEnv,
  request: Request,
  kind: 'login' | 'signup',
): Promise<{ status: 429; body: { error: string }; retryAfter: number } | null> {
  const ip = clientIp(request)
  const cheap = kind === 'login' ? env.LOGIN_LIMITER : env.SIGNUP_LIMITER
  const limit = kind === 'login' ? LOGIN_PER_MINUTE : SIGNUP_PER_MINUTE

  const message =
    kind === 'login'
      ? 'Too many sign-in attempts. Try again in a minute.'
      : 'Too many sign-up attempts. Try again in a minute.'

  if (!(await withinLimit(cheap, `${kind}:${ip}`))) {
    return { status: 429, body: { error: message }, retryAfter: 60 }
  }

  const verdict = await throttle(env.IP_THROTTLE, `${kind}:${ip}`, limit, 60)
  if (!verdict.ok) {
    return { status: 429, body: { error: message }, retryAfter: verdict.retryAfter }
  }
  return null
}

/**
 * Per-account backoff, on top of the per-IP limit.
 *
 * These catch different things. The IP limit stops one machine working through
 * a password list; it never sees a botnet spreading one account's guesses over
 * a thousand addresses. This does, because it counts against the account.
 *
 * Deliberately a backoff and not a lockout: a permanent lock turns "guess
 * wrong five times" into a way to deny a real customer their account. The wait
 * doubles and caps, and clears the moment a correct password arrives.
 */
const LOCK_AFTER_FAILURES = 5
const BACKOFF_BASE_SECONDS = 60
const BACKOFF_MAX_SECONDS = 900

function backoffSeconds(failures: number): number {
  if (failures < LOCK_AFTER_FAILURES) return 0
  const doublings = failures - LOCK_AFTER_FAILURES
  return Math.min(BACKOFF_BASE_SECONDS * 2 ** doublings, BACKOFF_MAX_SECONDS)
}

/* -------------------------------------------------------------------- types */

export interface User {
  id: string
  email: string
  name: string
}

export type AuthResult =
  | { status: 200; body: unknown; cookie?: string }
  | { status: 400 | 401 | 403 | 409 | 429 | 503; body: { error: string }; retryAfter?: number }

const str = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : null

const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)

/** Long enough to be a passphrase, short enough not to be a denial-of-service. */
const MIN_PASSWORD = 8
const MAX_PASSWORD = 200

const VERIFY_TOKEN_HOURS = 24

const siteUrl = (env: AuthEnv): string =>
  (env.ALLOWED_ORIGIN ?? 'http://localhost:5173').split(',')[0].trim()

/**
 * One sentence, used for both outcomes of a registration.
 *
 * It has to be true whether an account was just created or an email was sent
 * to an existing owner, and it has to be useful in both. "Check your email" is
 * the only thing that is.
 */
const REGISTRATION_ACCEPTED = {
  pending: true,
  message: 'Check your email to finish signing in.',
}

/* ----------------------------------------------------------------- sessions */

async function startSession(env: AuthEnv, userId: string): Promise<string> {
  const token = randomB64(32)
  await env.ORDERS.prepare(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?1,?2,?3)`,
  )
    .bind(await sha256(token), userId, inSeconds(SESSION_DAYS * 86_400))
    .run()
  return token
}

/**
 * Who this request is, if anyone.
 *
 * Returns null for every failure — no cookie, unknown token, expired session —
 * because the caller's only sensible response to all three is the same, and a
 * distinction here would eventually be surfaced as one.
 */
export async function sessionUser(env: AuthEnv, request: Request): Promise<User | null> {
  const token = readCookie(request, SESSION_COOKIE)
  if (!token) return null

  const row = await env.ORDERS.prepare(
    `SELECT u.id, u.email, u.name, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?1`,
  )
    .bind(await sha256(token))
    .first<{ id: string; email: string; name: string; expires_at: string }>()

  if (!row || isPast(row.expires_at)) return null
  return { id: row.id, email: row.email, name: row.name }
}

/* ----------------------------------------------------------------- register */

export async function register(
  env: AuthEnv,
  body: unknown,
  request: Request,
): Promise<AuthResult> {
  const limited = await guard(env, request, 'signup')
  if (limited) return limited

  if (typeof body !== 'object' || body === null) return { status: 400, body: { error: 'bad request' } }
  const p = body as { email?: unknown; password?: unknown; name?: unknown }

  const name = str(p.name, 120)
  if (!name) return { status: 400, body: { error: 'Tell us what to call you.' } }

  const email = str(p.email, 200)?.toLowerCase()
  if (!email || !isEmail(email)) return { status: 400, body: { error: 'That email does not look right.' } }

  const password = typeof p.password === 'string' ? p.password : ''
  if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    return { status: 400, body: { error: `Use at least ${MIN_PASSWORD} characters.` } }
  }

  /*
   * No transport, no registration.
   *
   * Without a way to reach the address, the only implementable flow is one
   * that says "taken" or "created" out loud — which is the leak this whole
   * design exists to close. Failing closed keeps the property and loses the
   * feature; failing open would keep the feature and quietly lose the
   * property, which is the worse trade every time.
   */
  const mailer = mailerFor(env)
  if (!mailer) {
    console.error('registration refused: no mail transport configured')
    return {
      status: 503,
      body: { error: 'Account creation is temporarily unavailable. Checkout works without an account.' },
    }
  }

  const site = siteUrl(env)
  const existing = await env.ORDERS.prepare(`SELECT id FROM users WHERE email = ?1`)
    .bind(email)
    .first<{ id: string }>()

  if (existing) {
    // Identical response, different email. The owner of the address finds out;
    // whoever typed it does not.
    const mail = alreadyRegisteredEmail(`${site}/account`)
    await mailer.send({ to: email, ...mail })
    return { status: 200, body: REGISTRATION_ACCEPTED }
  }

  const salt = crypto.getRandomValues(new Uint8Array(16))
  const hash = await derive(password, salt, PBKDF2_ITERATIONS)
  const id = `usr_${randomB64(16).replace(/[^A-Za-z0-9]/g, '')}`
  const token = randomToken()

  try {
    await env.ORDERS.batch([
      env.ORDERS.prepare(
        `INSERT INTO users (id, email, name, password_hash, password_salt, iterations)
         VALUES (?1,?2,?3,?4,?5,?6)`,
      ).bind(id, email, name, toB64(hash), toB64(salt), PBKDF2_ITERATIONS),
      env.ORDERS.prepare(
        `INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at) VALUES (?1,?2,'verify',?3)`,
      ).bind(await sha256(token), id, inSeconds(VERIFY_TOKEN_HOURS * 3600)),
    ])
  } catch (err) {
    // A race on the same address lands here. Same response as every other
    // outcome, because the whole point is that they are indistinguishable.
    if (/UNIQUE/i.test(String(err))) return { status: 200, body: REGISTRATION_ACCEPTED }
    console.error('register failed', err)
    return { status: 503, body: { error: 'Could not create the account. Try again shortly.' } }
  }

  const mail = verificationEmail(`${site}/verify?token=${encodeURIComponent(token)}`)
  await mailer.send({ to: email, ...mail })

  // No session yet. The account exists but is not usable until the link is
  // clicked, which is what makes the address verified rather than merely typed.
  return { status: 200, body: REGISTRATION_ACCEPTED }
}

/* -------------------------------------------------------------------- verify */

/**
 * Turns a link from an email into a verified account and a session.
 *
 * A POST, not a GET, and the link points at a page on the storefront that
 * makes this call. Mail scanners and link prefetchers follow GETs — a
 * one-shot token in a GET is a token spent by the recipient's security
 * appliance before the recipient ever reads the message.
 */
export async function verifyEmail(env: AuthEnv, body: unknown): Promise<AuthResult> {
  const token = typeof body === 'object' && body !== null ? str((body as { token?: unknown }).token, 200) : null
  if (!token) return { status: 400, body: { error: 'That link is not valid.' } }

  const row = await env.ORDERS.prepare(
    `SELECT t.user_id, t.expires_at, t.used_at, u.email, u.name
       FROM email_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ?1 AND t.purpose = 'verify'`,
  )
    .bind(await sha256(token))
    .first<{ user_id: string; expires_at: string; used_at: string | null; email: string; name: string }>()

  // One message for unknown, expired and already-used. They are all "this link
  // will not work, ask for another", and distinguishing them tells a stranger
  // holding a guessed token which part they got right.
  if (!row || row.used_at || isPast(row.expires_at)) {
    return { status: 400, body: { error: 'That link has expired or has already been used.' } }
  }

  await env.ORDERS.batch([
    env.ORDERS.prepare(`UPDATE email_tokens SET used_at = ?2 WHERE token_hash = ?1`).bind(
      await sha256(token),
      nowIso(),
    ),
    env.ORDERS.prepare(`UPDATE users SET email_verified_at = ?2 WHERE id = ?1`).bind(
      row.user_id,
      nowIso(),
    ),
  ])

  return {
    status: 200,
    body: { user: { id: row.user_id, email: row.email, name: row.name } satisfies User },
    cookie: sessionCookie(await startSession(env, row.user_id), SESSION_DAYS * 86_400),
  }
}

/* -------------------------------------------------------------------- login */

export async function login(env: AuthEnv, body: unknown, request: Request): Promise<AuthResult> {
  const limited = await guard(env, request, 'login')
  if (limited) return limited

  if (typeof body !== 'object' || body === null) return { status: 400, body: { error: 'bad request' } }
  const p = body as { email?: unknown; password?: unknown }

  const email = str(p.email, 200)?.toLowerCase() ?? ''
  const password = typeof p.password === 'string' ? p.password : ''

  const row = await env.ORDERS.prepare(
    `SELECT id, email, name, password_hash, password_salt, iterations,
            failed_attempts, locked_until, email_verified_at
       FROM users WHERE email = ?1`,
  )
    .bind(email)
    .first<{
      id: string
      email: string
      name: string
      password_hash: string
      password_salt: string
      iterations: number
      failed_attempts: number
      locked_until: string | null
      email_verified_at: string | null
    }>()

  const WRONG = { status: 401 as const, body: { error: 'That email and password do not match.' } }

  /*
   * An account in backoff gets the ordinary wrong-password answer, not a 429.
   *
   * A distinct status here would say "this address is registered" to anyone
   * willing to try it, which is exactly what registration goes to such lengths
   * to avoid. The person who really is typing their own password wrong will
   * hit the per-IP limit first and get a 429 that explains itself; the
   * distributed attacker this branch is for gets nothing to read.
   */
  if (row && !isPast(row.locked_until) && row.locked_until) return WRONG

  /*
   * An unknown email still pays for a full derivation before being refused.
   * Returning early would make "no such account" measurably faster than "wrong
   * password", which turns this endpoint into a way to find out who shops here.
   */
  const salt = row ? fromB64(row.password_salt) : new Uint8Array(16)
  const iterations = row?.iterations ?? PBKDF2_ITERATIONS
  const attempt = await derive(password, salt, iterations)

  if (!row || !sameBytes(attempt, fromB64(row.password_hash))) {
    if (row) {
      const failures = row.failed_attempts + 1
      const wait = backoffSeconds(failures)
      await env.ORDERS.prepare(
        `UPDATE users SET failed_attempts = ?2, locked_until = ?3 WHERE id = ?1`,
      )
        .bind(row.id, failures, wait ? inSeconds(wait) : null)
        .run()
    }
    return WRONG
  }

  // Correct password, unverified address. Safe to say so: it is only reachable
  // by someone who already knows the password.
  if (!row.email_verified_at) {
    return {
      status: 403,
      body: { error: 'Confirm your email first — check your inbox for the link we sent.' },
    }
  }

  // A correct password clears the count. Backoff is there to slow guessing,
  // not to punish someone who eventually remembered.
  await env.ORDERS.prepare(
    `UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?1`,
  )
    .bind(row.id)
    .run()

  return {
    status: 200,
    body: { user: { id: row.id, email: row.email, name: row.name } satisfies User },
    cookie: sessionCookie(await startSession(env, row.id), SESSION_DAYS * 86_400),
  }
}

/**
 * Ends this session server-side as well as in the browser.
 *
 * Clearing the cookie alone would leave a token that still works if it was
 * captured, which is the case that matters — signing out on a shared machine.
 */
export async function logout(env: AuthEnv, request: Request): Promise<AuthResult> {
  const token = readCookie(request, SESSION_COOKIE)
  if (token) {
    await env.ORDERS.prepare(`DELETE FROM sessions WHERE token_hash = ?1`)
      .bind(await sha256(token))
      .run()
  }
  return { status: 200, body: { ok: true }, cookie: sessionCookie('', 0) }
}

export interface AccountOrder {
  id: string
  placedAt: string
  total: number
  currency: string
  paymentCode: string
  itemCount: number
}

/** The signed-in shopper's own orders, newest first. */
export async function accountOrders(env: AuthEnv, user: User): Promise<AccountOrder[]> {
  const { results } = await env.ORDERS.prepare(
    `SELECT o.id, o.created_at, o.total_cents, o.currency, o.payment_status,
            (SELECT COALESCE(SUM(qty), 0) FROM order_lines WHERE order_id = o.id) AS items
       FROM orders o
      WHERE o.user_id = ?1
      ORDER BY o.created_at DESC
      LIMIT 50`,
  )
    .bind(user.id)
    .all<{
      id: string
      created_at: string
      total_cents: number
      currency: string
      payment_status: string
      items: number
    }>()

  return (results ?? []).map((r) => ({
    id: r.id,
    placedAt: r.created_at,
    total: r.total_cents,
    currency: r.currency,
    paymentCode: r.payment_status,
    itemCount: r.items,
  }))
}

/** For /api/health: whether the protections are actually wired, not assumed. */
export const authDefences = (env: AuthEnv) => ({
  mail: mailerFor(env) !== null,
  loginRateLimit: Boolean(env.LOGIN_LIMITER),
  signupRateLimit: Boolean(env.SIGNUP_LIMITER),
  /** The one whose count can be trusted. Without it the others are advisory. */
  durableThrottle: Boolean(env.IP_THROTTLE),
})
