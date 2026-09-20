/**
 * Accounts and sessions.
 *
 * An account here buys exactly one thing: the orders you placed while signed
 * in, readable from any device. That is deliberately narrow. The cart and the
 * comparison stay on the device, because they are better there — nobody wants
 * yesterday's phone basket following them onto a work laptop.
 *
 * Three decisions worth knowing about:
 *
 * 1. Orders are linked to an account by `user_id` at the moment they are
 *    placed, never by matching email. Email here is unverified — anyone can
 *    register `someone@else.com` — so an email join would hand a stranger a
 *    real customer's address and order history for the price of a signup.
 *
 * 2. The session cookie is HttpOnly. The token never touches JavaScript, so a
 *    script injected into the storefront cannot read it. That costs a little:
 *    the client cannot inspect its own session and has to ask `/api/auth/me`.
 *
 * 3. What is stored is the SHA-256 of the token, not the token. A dump of the
 *    sessions table is then a list of hashes rather than a set of working keys.
 */
import type { OrdersEnv } from './orders'

export interface AuthEnv extends OrdersEnv {}

/* --------------------------------------------------------------- primitives */

const encoder = new TextEncoder()

const toB64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes))
const fromB64 = (text: string): Uint8Array =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0))

/**
 * PBKDF2-HMAC-SHA256.
 *
 * Not bcrypt or argon2: neither exists in the Workers runtime, and shipping a
 * WASM build of one to hash a demo store's passwords is a larger risk surface
 * than the thing it protects. PBKDF2 is the strongest primitive available here
 * natively, which makes the iteration count the only real dial.
 *
 * ponytail: 210k is the OWASP floor for this algorithm, chosen against the
 * Workers CPU budget. It is recorded per user rather than assumed, so raising
 * it later re-hashes people as they sign in instead of locking them out.
 */
const PBKDF2_ITERATIONS = 210_000

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

/* -------------------------------------------------------------------- types */

export interface User {
  id: string
  email: string
  name: string
}

export type AuthResult =
  | { status: 200; body: unknown; cookie?: string }
  | { status: 400 | 401 | 409 | 503; body: { error: string } }

const str = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : null

const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)

/** Long enough to be a passphrase, short enough not to be a denial-of-service. */
const MIN_PASSWORD = 8
const MAX_PASSWORD = 200

/* ----------------------------------------------------------------- sessions */

async function startSession(env: AuthEnv, userId: string): Promise<string> {
  const token = randomB64(32)
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString()

  await env.ORDERS.prepare(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?1,?2,?3)`,
  )
    .bind(await sha256(token), userId, expires)
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

  if (!row) return null
  if (new Date(row.expires_at).getTime() < Date.now()) return null
  return { id: row.id, email: row.email, name: row.name }
}

/* ----------------------------------------------------------------- handlers */

export async function register(env: AuthEnv, body: unknown): Promise<AuthResult> {
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

  const salt = crypto.getRandomValues(new Uint8Array(16))
  const hash = await derive(password, salt, PBKDF2_ITERATIONS)
  const id = `usr_${randomB64(16).replace(/[^A-Za-z0-9]/g, '')}`

  try {
    await env.ORDERS.prepare(
      `INSERT INTO users (id, email, name, password_hash, password_salt, iterations)
       VALUES (?1,?2,?3,?4,?5,?6)`,
    )
      .bind(id, email, name, toB64(hash), toB64(salt), PBKDF2_ITERATIONS)
      .run()
  } catch (err) {
    if (/UNIQUE/i.test(String(err))) {
      return { status: 409, body: { error: 'That email already has an account. Sign in instead.' } }
    }
    console.error('register failed', err)
    return { status: 503, body: { error: 'Could not create the account. Try again shortly.' } }
  }

  return {
    status: 200,
    body: { user: { id, email, name } satisfies User },
    cookie: sessionCookie(await startSession(env, id), SESSION_DAYS * 86_400),
  }
}

export async function login(env: AuthEnv, body: unknown): Promise<AuthResult> {
  if (typeof body !== 'object' || body === null) return { status: 400, body: { error: 'bad request' } }
  const p = body as { email?: unknown; password?: unknown }

  const email = str(p.email, 200)?.toLowerCase() ?? ''
  const password = typeof p.password === 'string' ? p.password : ''

  const row = await env.ORDERS.prepare(
    `SELECT id, email, name, password_hash, password_salt, iterations FROM users WHERE email = ?1`,
  )
    .bind(email)
    .first<{
      id: string
      email: string
      name: string
      password_hash: string
      password_salt: string
      iterations: number
    }>()

  /*
   * An unknown email still pays for a full derivation before being refused.
   * Returning early would make "no such account" measurably faster than "wrong
   * password", which turns this endpoint into a way to find out who shops here.
   */
  const salt = row ? fromB64(row.password_salt) : new Uint8Array(16)
  const iterations = row?.iterations ?? PBKDF2_ITERATIONS
  const attempt = await derive(password, salt, iterations)

  if (!row || !sameBytes(attempt, fromB64(row.password_hash))) {
    // One message for both, for the same reason.
    return { status: 401, body: { error: 'That email and password do not match.' } }
  }

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
