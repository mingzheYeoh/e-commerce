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
import {
  mailerFor,
  verificationEmail,
  alreadyRegisteredEmail,
  passwordResetEmail,
  type MailEnv,
} from './mail'
import { throttle, type ThrottleBinding } from './throttle'
import { tooCommon } from './pwned'
import {
  newTotpSecret,
  verifyTotp,
  otpauthUri,
  newRecoveryCodes,
  normaliseRecoveryCode,
} from './totp'
import {
  toB64,
  fromB64,
  PBKDF2_ITERATIONS,
  KDF_ROUNDS,
  derive,
  sameBytes,
  sha256,
  randomB64,
  randomToken,
  nowIso,
  inSeconds,
  isPast,
  LOCKOUT_THRESHOLD,
  LOCKOUT_MINUTES,
} from './credentials'

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

/** What the runtime will accept in one call. Above this, `deriveBits` throws. */
export const MAX_PBKDF2_ITERATIONS = 100_000

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
 *
 * The threshold and the base wait are shared with staff sign-in via
 * `credentials.ts`; the doubling and the cap are a customer-login policy
 * choice and stay here.
 */
const BACKOFF_BASE_SECONDS = LOCKOUT_MINUTES * 60
const BACKOFF_MAX_SECONDS = 900

function backoffSeconds(failures: number): number {
  if (failures < LOCKOUT_THRESHOLD) return 0
  const doublings = failures - LOCKOUT_THRESHOLD
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
  | {
      status: 400 | 401 | 403 | 409 | 429 | 503
      /** `mfaRequired` is how the form knows to ask for a code rather than retry. */
      body: { error: string; mfaRequired?: boolean }
      retryAfter?: number
    }

const str = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : null

const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)

/** Long enough to be a passphrase, short enough not to be a denial-of-service. */
const MIN_PASSWORD = 8
const MAX_PASSWORD = 200

const VERIFY_TOKEN_HOURS = 24
/**
 * Much shorter than a verification link.
 *
 * A reset token is a live key to an existing account, where a verification
 * token only finishes setting one up. An hour is long enough to find the
 * message and short enough that one left in a mail archive is dead.
 */
const RESET_TOKEN_MINUTES = 60

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
  /*
   * Length is a poor predictor and everybody knows it. `Password1!` clears
   * most length-and-symbol rules and sits in breach corpora millions of
   * times over; what actually predicts a guess is whether someone has
   * already guessed it.
   *
   * Only the first five characters of the SHA-1 leave this worker.
   */
  const breached = await tooCommon(password)
  if (breached) return { status: 400, body: { error: breached } }

  const mailer = mailerFor(env)
  if (!mailer) {
    console.error('registration refused: no mail transport configured')
    return {
      status: 503,
      body: { error: 'Account creation is temporarily unavailable. Checkout works without an account.' },
    }
  }

  const site = siteUrl(env)
  const existing = await env.ORDERS
    .prepare(`SELECT id, email_verified_at FROM users WHERE email = ?1`)
    .bind(email)
    .first<{ id: string; email_verified_at: string | null }>()

  /*
   * What to say when the message could not be sent.
   *
   * "Check your email" is only true if something was sent. A provider that
   * refuses — an unverified sending domain, a quota, an outage — otherwise
   * produces a registration that looks finished and leaves the shopper
   * refreshing an inbox that will never receive anything.
   *
   * It is the same answer whether or not the address already had an account,
   * because the failure is a property of the recipient, not of the account.
   */
  const UNDELIVERABLE = {
    status: 503 as const,
    body: { error: 'We could not send the confirmation email. Try again shortly.' },
  }

  if (existing) {
    /*
     * An account that was started and never confirmed is not the same as one
     * in use, and telling them apart is what fixes a dead end: the link
     * expires after a day, registering again answered "you already have an
     * account, sign in", and signing in answered "confirm your email first —
     * check your inbox for the link we sent". The link that had expired. There
     * was no way out, and the address was taken.
     *
     * So an unverified account gets a fresh link instead, and the password is
     * replaced by whatever was just typed.
     *
     * That replacement is the security half. Without it, someone could sign up
     * with an address that is not theirs, wait, and be holding a working
     * password on the day its real owner registers and confirms. Overwriting
     * means the credential that survives belongs to whoever last typed one
     * before the inbox was proven — and proving the inbox is the step the
     * attacker can never take.
     */
    if (!existing.email_verified_at) {
      const salt = crypto.getRandomValues(new Uint8Array(16))
      const hash = await derive(password, salt, KDF_ROUNDS)
      const token = randomToken()

      await env.ORDERS.batch([
        env.ORDERS.prepare(
          `UPDATE users SET name = ?2, password_hash = ?3, password_salt = ?4, iterations = ?5,
                            kdf_rounds = ?6, failed_attempts = 0, locked_until = NULL
             WHERE id = ?1`,
        ).bind(existing.id, name, toB64(hash), toB64(salt), PBKDF2_ITERATIONS, KDF_ROUNDS),
        // Any earlier link stops working. Two live links to one unconfirmed
        // account is two chances for the wrong person to hold one.
        env.ORDERS.prepare(
          `DELETE FROM email_tokens WHERE user_id = ?1 AND purpose = 'verify'`,
        ).bind(existing.id),
        env.ORDERS.prepare(
          `INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at) VALUES (?1,?2,'verify',?3)`,
        ).bind(await sha256(token), existing.id, inSeconds(VERIFY_TOKEN_HOURS * 3600)),
      ])

      const mail = verificationEmail(`${site}/verify?token=${encodeURIComponent(token)}`)
      if (!(await mailer.send({ to: email, ...mail }))) return UNDELIVERABLE
      return { status: 200, body: REGISTRATION_ACCEPTED }
    }

    // Identical response, different email. The owner of the address finds out;
    // whoever typed it does not.
    const mail = alreadyRegisteredEmail(`${site}/account`)
    if (!(await mailer.send({ to: email, ...mail }))) return UNDELIVERABLE
    return { status: 200, body: REGISTRATION_ACCEPTED }
  }

  const salt = crypto.getRandomValues(new Uint8Array(16))
  const hash = await derive(password, salt, KDF_ROUNDS)
  const id = `usr_${randomB64(16).replace(/[^A-Za-z0-9]/g, '')}`
  const token = randomToken()

  try {
    await env.ORDERS.batch([
      env.ORDERS.prepare(
        `INSERT INTO users (id, email, name, password_hash, password_salt, iterations, kdf_rounds)
         VALUES (?1,?2,?3,?4,?5,?6,?7)`,
      ).bind(id, email, name, toB64(hash), toB64(salt), PBKDF2_ITERATIONS, KDF_ROUNDS),
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
  if (!(await mailer.send({ to: email, ...mail }))) {
    /*
     * Undo it. An account whose only key was in an email that never arrived is
     * unreachable AND in the way: the address is taken, so trying again hits
     * the unique constraint and the shopper is locked out of their own email
     * address by a message they never got.
     */
    await env.ORDERS.batch([
      env.ORDERS.prepare(`DELETE FROM email_tokens WHERE user_id = ?1`).bind(id),
      env.ORDERS.prepare(`DELETE FROM users WHERE id = ?1`).bind(id),
    ])
    return UNDELIVERABLE
  }

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

  /*
   * Both kinds of link land here, because to the person holding one they are
   * the same thing: a message that says click this. Splitting them into two
   * endpoints and two pages would be two ways to say "that did not work".
   */
  const row = await env.ORDERS.prepare(
    `SELECT t.user_id, t.purpose, t.expires_at, t.used_at, u.email, u.name, u.pending_email
       FROM email_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ?1 AND t.purpose IN ('verify','email_change')`,
  )
    .bind(await sha256(token))
    .first<{
      user_id: string
      purpose: string
      expires_at: string
      used_at: string | null
      email: string
      name: string
      pending_email: string | null
    }>()

  // One message for unknown, expired and already-used. They are all "this link
  // will not work, ask for another", and distinguishing them tells a stranger
  // holding a guessed token which part they got right.
  if (!row || row.used_at || isPast(row.expires_at)) {
    return { status: 400, body: { error: 'That link has expired or has already been used.' } }
  }

  const spend = env.ORDERS.prepare(`UPDATE email_tokens SET used_at = ?2 WHERE token_hash = ?1`).bind(
    await sha256(token),
    nowIso(),
  )

  if (row.purpose === 'email_change') {
    if (!row.pending_email) {
      return { status: 400, body: { error: 'That change was already cancelled.' } }
    }

    /*
     * The collision is caught here rather than when the change was requested.
     *
     * Reporting "that address is taken" on the settings form would turn it
     * into the account-existence oracle registration goes to such lengths to
     * avoid — and one that comes with free confirmation the asker is a real
     * signed-in customer. By the time somebody is holding a link sent to the
     * address, they read that inbox, so there is nothing left to leak.
     */
    try {
      await env.ORDERS.batch([
        spend,
        env.ORDERS.prepare(
          `UPDATE users SET email = ?2, pending_email = NULL, email_verified_at = ?3 WHERE id = ?1`,
        ).bind(row.user_id, row.pending_email, nowIso()),
      ])
    } catch (err) {
      if (/UNIQUE/i.test(String(err))) {
        await env.ORDERS.prepare(`UPDATE users SET pending_email = NULL WHERE id = ?1`)
          .bind(row.user_id)
          .run()
        return {
          status: 409,
          body: { error: 'That address is no longer available. Your account is unchanged.' },
        }
      }
      throw err
    }

    return {
      status: 200,
      body: {
        user: { id: row.user_id, email: row.pending_email, name: row.name } satisfies User,
        changed: 'email',
      },
      cookie: sessionCookie(await startSession(env, row.user_id), SESSION_DAYS * 86_400),
    }
  }

  await env.ORDERS.batch([
    spend,
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
    `SELECT id, email, name, password_hash, password_salt, iterations, kdf_rounds,
            failed_attempts, locked_until, email_verified_at, totp_secret, totp_confirmed_at
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
      kdf_rounds: number
      failed_attempts: number
      locked_until: string | null
      email_verified_at: string | null
      totp_secret: string | null
      totp_confirmed_at: string | null
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
  // An unknown address is hashed at the current cost, so it takes as long as
  // a real one rather than finishing early and saying so.
  const rounds = row?.kdf_rounds ?? KDF_ROUNDS
  const attempt = await derive(password, salt, rounds)

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

  /*
   * The second factor, if there is one.
   *
   * Asked for only after the password is known to be right, which does tell a
   * caller holding a correct password that the account exists — but they hold
   * a correct password, so there is nothing left to conceal. A recovery code is
   * accepted in the same field: somebody whose phone is gone is already having
   * a bad day and should not have to find a different form.
   */
  if (row.totp_confirmed_at && row.totp_secret) {
    const code = str((p as { code?: unknown }).code, 40)
    if (!code) {
      return {
        status: 403,
        body: { error: 'Enter the code from your authenticator app.', mfaRequired: true },
      }
    }

    const accepted =
      (await verifyTotp(row.totp_secret, code)) || (await spendRecoveryCode(env, row.id, code))
    if (!accepted) {
      return { status: 401, body: { error: 'That code is not right.', mfaRequired: true } }
    }
  }

  // A correct password clears the count. Backoff is there to slow guessing,
  // not to punish someone who eventually remembered.
  await env.ORDERS.prepare(
    `UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?1`,
  )
    .bind(row.id)
    .run()

  /*
   * And this is the moment an old hash gets upgraded.
   *
   * It is the only point where the plaintext password and the stored row are
   * both in hand, so it is the only place a stronger work factor can be
   * applied without asking anybody to do anything. Deliberately not awaited
   * into the response — a failed re-hash leaves a working older hash, which is
   * not worth failing a sign-in over.
   */
  if (row.kdf_rounds < KDF_ROUNDS) {
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const upgraded = await derive(password, salt, KDF_ROUNDS)
    await env.ORDERS.prepare(
      `UPDATE users SET password_hash = ?2, password_salt = ?3, kdf_rounds = ?4 WHERE id = ?1`,
    )
      .bind(row.id, toB64(upgraded), toB64(salt), KDF_ROUNDS)
      .run()
      .catch((err) => console.error('rehash failed', err))
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

/** For /api/health: whether the protections are actually wired, not assumed. */
export const authDefences = (env: AuthEnv) => ({
  mail: mailerFor(env) !== null,
  loginRateLimit: Boolean(env.LOGIN_LIMITER),
  signupRateLimit: Boolean(env.SIGNUP_LIMITER),
  /** The one whose count can be trusted. Without it the others are advisory. */
  durableThrottle: Boolean(env.IP_THROTTLE),
})

/* ------------------------------------------------------- forgotten password */

/**
 * The one sentence both outcomes get.
 *
 * Same discipline as registration: whether an address has an account is told
 * to the inbox, not to whoever filled in the form. An honest "if that address
 * has an account" is also the only phrasing that is true in both cases.
 */
const RESET_REQUESTED = {
  sent: true,
  message: 'If that address has an account, a reset link is on its way.',
}

export async function requestPasswordReset(
  env: AuthEnv,
  body: unknown,
  request: Request,
): Promise<AuthResult> {
  // Sending mail on demand to an address a stranger chose is a way to use this
  // store as someone else's spam relay, so it is throttled like signing up.
  const limited = await guard(env, request, 'signup')
  if (limited) return limited

  if (typeof body !== 'object' || body === null) return { status: 400, body: { error: 'bad request' } }
  const email = str((body as { email?: unknown }).email, 200)?.toLowerCase() ?? ''

  const mailer = mailerFor(env)
  if (!mailer) {
    console.error('reset refused: no mail transport configured')
    return {
      status: 503,
      body: { error: 'Password reset is temporarily unavailable.' },
    }
  }

  const user = await env.ORDERS.prepare(
    `SELECT id, email_verified_at FROM users WHERE email = ?1`,
  )
    .bind(email)
    .first<{ id: string; email_verified_at: string | null }>()

  /*
   * Nothing is sent for an unknown address, or for one that was never
   * confirmed — there is no proof anyone reading that inbox ever wanted an
   * account here. An unconfirmed account's way back in is to register again,
   * which reissues its link.
   *
   * Either way the answer above is the same one a real reset gets.
   */
  if (user?.email_verified_at) {
    const token = randomToken()
    await env.ORDERS.batch([
      // One live reset link at a time. An older one in a mail archive stops
      // working the moment a newer one is asked for.
      env.ORDERS.prepare(`DELETE FROM email_tokens WHERE user_id = ?1 AND purpose = 'reset'`).bind(
        user.id,
      ),
      env.ORDERS.prepare(
        `INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at) VALUES (?1,?2,'reset',?3)`,
      ).bind(await sha256(token), user.id, inSeconds(RESET_TOKEN_MINUTES * 60)),
    ])

    const site = siteUrl(env)
    const mail = passwordResetEmail(`${site}/reset?token=${encodeURIComponent(token)}`)
    // A send failure is NOT reported here, unlike registration. Saying "we
    // could not send it" for one address and "if that address has an account"
    // for another rebuilds the oracle this endpoint exists to avoid. It is
    // logged instead.
    if (!(await mailer.send({ to: email, ...mail }))) {
      console.error('reset email could not be sent')
    }
  }

  return { status: 200, body: RESET_REQUESTED }
}

/**
 * Sets a new password from a reset link, and ends every existing session.
 *
 * The sign-out is the part that matters. Somebody resetting a password often
 * does it because they think someone else has it; leaving that person's
 * session alive makes the reset a gesture.
 */
export async function resetPassword(env: AuthEnv, body: unknown): Promise<AuthResult> {
  if (typeof body !== 'object' || body === null) return { status: 400, body: { error: 'bad request' } }
  const p = body as { token?: unknown; password?: unknown }

  const token = str(p.token, 200)
  if (!token) return { status: 400, body: { error: 'That link is not valid.' } }

  const password = typeof p.password === 'string' ? p.password : ''
  if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    return { status: 400, body: { error: `Use at least ${MIN_PASSWORD} characters.` } }
  }

  const row = await env.ORDERS.prepare(
    `SELECT t.user_id, t.expires_at, t.used_at, u.email, u.name
       FROM email_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ?1 AND t.purpose = 'reset'`,
  )
    .bind(await sha256(token))
    .first<{ user_id: string; expires_at: string; used_at: string | null; email: string; name: string }>()

  if (!row || row.used_at || isPast(row.expires_at)) {
    return { status: 400, body: { error: 'That link has expired or has already been used.' } }
  }

  const breached = await tooCommon(password)
  if (breached) return { status: 400, body: { error: breached } }

  const salt = crypto.getRandomValues(new Uint8Array(16))
  const hash = await derive(password, salt, KDF_ROUNDS)

  await env.ORDERS.batch([
    env.ORDERS.prepare(`UPDATE email_tokens SET used_at = ?2 WHERE token_hash = ?1`).bind(
      await sha256(token),
      nowIso(),
    ),
    env.ORDERS.prepare(
      `UPDATE users SET password_hash = ?2, password_salt = ?3, iterations = ?4, kdf_rounds = ?5,
                        failed_attempts = 0, locked_until = NULL,
                        email_verified_at = COALESCE(email_verified_at, ?6)
         WHERE id = ?1`,
    ).bind(row.user_id, toB64(hash), toB64(salt), PBKDF2_ITERATIONS, KDF_ROUNDS, nowIso()),
    // Everywhere, including whoever they are resetting because of.
    env.ORDERS.prepare(`DELETE FROM sessions WHERE user_id = ?1`).bind(row.user_id),
  ])

  return {
    status: 200,
    body: { user: { id: row.user_id, email: row.email, name: row.name } satisfies User },
    cookie: sessionCookie(await startSession(env, row.user_id), SESSION_DAYS * 86_400),
  }
}

/* ------------------------------------------------------------------ hygiene */

/**
 * Deletes what has aged out. Run from a scheduled trigger, nightly.
 *
 * Expired rows were already refused on read, so this changes no behaviour —
 * it stops two tables growing forever. A year of a storefront nobody cleans
 * up is a sessions table that is almost entirely dead keys, which is both a
 * cost and a bigger thing to lose in a breach.
 *
 * Used-but-unexpired tokens are kept on purpose: while a spent link is still
 * inside its own lifetime, "already used" is a more useful answer than
 * "never existed", and they cost nothing for an hour.
 */
export async function purgeExpired(env: AuthEnv): Promise<{ sessions: number; tokens: number }> {
  const now = nowIso()
  const [sessions, tokens] = await env.ORDERS.batch([
    env.ORDERS.prepare(`DELETE FROM sessions WHERE expires_at < ?1`).bind(now),
    env.ORDERS.prepare(`DELETE FROM email_tokens WHERE expires_at < ?1`).bind(now),
  ])
  return {
    sessions: sessions.meta?.changes ?? 0,
    tokens: tokens.meta?.changes ?? 0,
  }
}

/* ------------------------------------------------------- account settings */

/**
 * Every setting below asks for the current password again.
 *
 * A live session is not proof that the person at the keyboard is the account's
 * owner — an unlocked laptop is the whole point of the attack. Re-asking costs
 * a returning owner four seconds and costs somebody who sat down at their desk
 * everything.
 */
async function passwordMatches(env: AuthEnv, userId: string, password: string): Promise<boolean> {
  const row = await env.ORDERS.prepare(
    `SELECT password_hash, password_salt, kdf_rounds FROM users WHERE id = ?1`,
  )
    .bind(userId)
    .first<{ password_hash: string; password_salt: string; kdf_rounds: number }>()
  if (!row) return false

  const attempt = await derive(password, fromB64(row.password_salt), row.kdf_rounds)
  return sameBytes(attempt, fromB64(row.password_hash))
}

const WRONG_PASSWORD = {
  status: 401 as const,
  body: { error: 'That password is not right.' },
}

export async function changePassword(
  env: AuthEnv,
  user: User,
  body: unknown,
): Promise<AuthResult> {
  if (typeof body !== 'object' || body === null) return { status: 400, body: { error: 'bad request' } }
  const p = body as { current?: unknown; next?: unknown }

  const current = typeof p.current === 'string' ? p.current : ''
  const next = typeof p.next === 'string' ? p.next : ''

  if (next.length < MIN_PASSWORD || next.length > MAX_PASSWORD) {
    return { status: 400, body: { error: `Use at least ${MIN_PASSWORD} characters.` } }
  }
  if (!(await passwordMatches(env, user.id, current))) return WRONG_PASSWORD

  const breached = await tooCommon(next)
  if (breached) return { status: 400, body: { error: breached } }

  const salt = crypto.getRandomValues(new Uint8Array(16))
  const hash = await derive(next, salt, KDF_ROUNDS)

  await env.ORDERS.prepare(
    `UPDATE users SET password_hash = ?2, password_salt = ?3, iterations = ?4, kdf_rounds = ?5,
                      failed_attempts = 0, locked_until = NULL
       WHERE id = ?1`,
  )
    .bind(user.id, toB64(hash), toB64(salt), PBKDF2_ITERATIONS, KDF_ROUNDS)
    .run()

  /*
   * Other sessions survive a deliberate change, unlike a reset.
   *
   * The two look similar and mean different things. A reset is what somebody
   * does when they think another person has their password, so it ends
   * everything. This is routine hygiene from a signed-in device, and quietly
   * signing the owner out of their phone is an unpleasant surprise — the
   * button for that is next to this one, and it is theirs to press.
   */
  return { status: 200, body: { ok: true, message: 'Password changed.' } }
}

/**
 * Starts a change of address. The account keeps working on the old one.
 *
 * Confirmation goes to the NEW address, because the point is to prove somebody
 * reads it. Nothing moves until they click.
 */
export async function requestEmailChange(
  env: AuthEnv,
  user: User,
  body: unknown,
  request: Request,
): Promise<AuthResult> {
  const limited = await guard(env, request, 'signup')
  if (limited) return limited

  if (typeof body !== 'object' || body === null) return { status: 400, body: { error: 'bad request' } }
  const p = body as { password?: unknown; email?: unknown }

  const email = str(p.email, 200)?.toLowerCase()
  if (!email || !isEmail(email)) return { status: 400, body: { error: 'That email does not look right.' } }
  if (email === user.email) {
    return { status: 400, body: { error: 'That is already the address on this account.' } }
  }
  if (!(await passwordMatches(env, user.id, typeof p.password === 'string' ? p.password : ''))) {
    return WRONG_PASSWORD
  }

  const mailer = mailerFor(env)
  if (!mailer) {
    console.error('email change refused: no mail transport configured')
    return { status: 503, body: { error: 'Changing your email is temporarily unavailable.' } }
  }

  /*
   * Whether the new address is already taken is NOT reported here. It would
   * turn an ordinary settings form into the account-existence oracle that
   * registration goes to such lengths to avoid — and this one comes with a
   * free confirmation that the asker is a real signed-in customer.
   *
   * The collision is caught at redemption instead, where the answer is "that
   * address is no longer available" and the account is unchanged.
   */
  const token = randomToken()
  await env.ORDERS.batch([
    env.ORDERS.prepare(`UPDATE users SET pending_email = ?2 WHERE id = ?1`).bind(user.id, email),
    env.ORDERS.prepare(
      `DELETE FROM email_tokens WHERE user_id = ?1 AND purpose = 'email_change'`,
    ).bind(user.id),
    env.ORDERS.prepare(
      `INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at) VALUES (?1,?2,'email_change',?3)`,
    ).bind(await sha256(token), user.id, inSeconds(VERIFY_TOKEN_HOURS * 3600)),
  ])

  const site = siteUrl(env)
  const mail = verificationEmail(`${site}/verify?token=${encodeURIComponent(token)}`)
  if (!(await mailer.send({ to: email, ...mail }))) {
    return { status: 503, body: { error: 'We could not send the confirmation email. Try again shortly.' } }
  }

  return {
    status: 200,
    body: { ok: true, message: `Check ${email} for a link. Nothing changes until you click it.` },
  }
}

/* ------------------------------------------------------------- other devices */

/**
 * Ends every session except the one asking.
 *
 * The "I was signed in somewhere I should not have been" button. Keeping the
 * current one is the difference between this and a reset: nobody wants to sign
 * themselves out while pressing it.
 */
export async function revokeOtherSessions(env: AuthEnv, user: User, request: Request): Promise<AuthResult> {
  const token = readCookie(request, SESSION_COOKIE)
  const { meta } = await env.ORDERS.prepare(
    `DELETE FROM sessions WHERE user_id = ?1 AND token_hash != ?2`,
  )
    .bind(user.id, token ? await sha256(token) : '')
    .run()

  const ended = meta?.changes ?? 0
  return {
    status: 200,
    body: {
      ok: true,
      ended,
      message: ended
        ? `Signed out of ${ended} other ${ended === 1 ? 'device' : 'devices'}.`
        : 'No other devices were signed in.',
    },
  }
}

/** How many places this account is currently signed in, this one included. */
export async function activeSessionCount(env: AuthEnv, user: User): Promise<number> {
  const row = await env.ORDERS.prepare(
    `SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?1 AND expires_at > ?2`,
  )
    .bind(user.id, nowIso())
    .first<{ n: number }>()
  return row?.n ?? 0
}

/* ------------------------------------------------------------------ closing */

/**
 * Closes the account.
 *
 * Orders are deliberately NOT deleted. They are the record of a transaction
 * that happened, each one carrying the address it shipped to and the price
 * that was charged; erasing them on request would erase the shop's side of it
 * too. What goes is the link — `user_id` is cleared, so the order survives as
 * a receipt reachable by its own id and belongs to no account.
 *
 * This is stated on the page rather than buried here, because it is the sort
 * of thing somebody should know before pressing the button and not after.
 */
export async function deleteAccount(env: AuthEnv, user: User, body: unknown): Promise<AuthResult> {
  if (typeof body !== 'object' || body === null) return { status: 400, body: { error: 'bad request' } }
  const password = typeof (body as { password?: unknown }).password === 'string'
    ? ((body as { password: string }).password)
    : ''

  if (!(await passwordMatches(env, user.id, password))) return WRONG_PASSWORD

  await env.ORDERS.batch([
    env.ORDERS.prepare(`UPDATE orders SET user_id = NULL WHERE user_id = ?1`).bind(user.id),
    env.ORDERS.prepare(`DELETE FROM recovery_codes WHERE user_id = ?1`).bind(user.id),
    env.ORDERS.prepare(`DELETE FROM email_tokens WHERE user_id = ?1`).bind(user.id),
    env.ORDERS.prepare(`DELETE FROM sessions WHERE user_id = ?1`).bind(user.id),
    env.ORDERS.prepare(`DELETE FROM users WHERE id = ?1`).bind(user.id),
  ])

  return {
    status: 200,
    body: { ok: true, message: 'Your account is closed.' },
    cookie: sessionCookie('', 0),
  }
}

/* --------------------------------------------------------- second factor */

/**
 * Generates a secret and hands back what the app needs to store it.
 *
 * Nothing is turned on yet. The secret is written so the confirm step can
 * check a code against it, but `totp_confirmed_at` stays null until a real
 * code arrives — a secret that was generated and never successfully used must
 * not be able to lock anybody out of their own account.
 */
export async function startTotpEnrolment(env: AuthEnv, user: User, body: unknown): Promise<AuthResult> {
  const password = typeof body === 'object' && body !== null && typeof (body as { password?: unknown }).password === 'string'
    ? (body as { password: string }).password
    : ''
  if (!(await passwordMatches(env, user.id, password))) return WRONG_PASSWORD

  const secret = newTotpSecret()
  await env.ORDERS.prepare(
    `UPDATE users SET totp_secret = ?2, totp_confirmed_at = NULL WHERE id = ?1`,
  )
    .bind(user.id, secret)
    .run()

  return {
    status: 200,
    body: {
      secret,
      uri: otpauthUri(user.email, secret),
    },
  }
}

/**
 * Turns it on, and issues the codes that make it survivable.
 *
 * The recovery codes are returned exactly once, here. They are stored as
 * hashes, so nobody — including this service — can show them again.
 */
export async function confirmTotpEnrolment(env: AuthEnv, user: User, body: unknown): Promise<AuthResult> {
  const code = typeof body === 'object' && body !== null ? str((body as { code?: unknown }).code, 40) : null
  if (!code) return { status: 400, body: { error: 'Enter the six-digit code.' } }

  const row = await env.ORDERS.prepare(`SELECT totp_secret FROM users WHERE id = ?1`)
    .bind(user.id)
    .first<{ totp_secret: string | null }>()
  if (!row?.totp_secret) {
    return { status: 400, body: { error: 'Start again — there is no pending setup.' } }
  }
  if (!(await verifyTotp(row.totp_secret, code))) {
    return { status: 400, body: { error: 'That code is not right. Check your phone’s clock and try the next one.' } }
  }

  const codes = newRecoveryCodes()
  await env.ORDERS.batch([
    env.ORDERS.prepare(`UPDATE users SET totp_confirmed_at = ?2 WHERE id = ?1`).bind(user.id, nowIso()),
    // Any codes from a previous enrolment stop working.
    env.ORDERS.prepare(`DELETE FROM recovery_codes WHERE user_id = ?1`).bind(user.id),
    ...(await Promise.all(
      codes.map(async (code) =>
        env.ORDERS.prepare(`INSERT INTO recovery_codes (code_hash, user_id) VALUES (?1,?2)`).bind(
          await sha256(normaliseRecoveryCode(code)),
          user.id,
        ),
      ),
    )),
  ])

  return { status: 200, body: { ok: true, recoveryCodes: codes } }
}

export async function disableTotp(env: AuthEnv, user: User, body: unknown): Promise<AuthResult> {
  const password = typeof body === 'object' && body !== null && typeof (body as { password?: unknown }).password === 'string'
    ? (body as { password: string }).password
    : ''
  if (!(await passwordMatches(env, user.id, password))) return WRONG_PASSWORD

  await env.ORDERS.batch([
    env.ORDERS.prepare(
      `UPDATE users SET totp_secret = NULL, totp_confirmed_at = NULL WHERE id = ?1`,
    ).bind(user.id),
    env.ORDERS.prepare(`DELETE FROM recovery_codes WHERE user_id = ?1`).bind(user.id),
  ])

  return { status: 200, body: { ok: true, message: 'Two-factor authentication is off.' } }
}

/**
 * Spends a recovery code, if the string is one.
 *
 * Every unused code for the account is hashed and compared, because the code
 * arrives as text and the table holds hashes — there is nothing to look up by.
 * The comparison is on hashes of equal length, so it does not leak which one
 * nearly matched.
 */
async function spendRecoveryCode(env: AuthEnv, userId: string, code: string): Promise<boolean> {
  const normalised = normaliseRecoveryCode(code)
  if (normalised.length < 8) return false

  const hash = await sha256(normalised)
  const { meta } = await env.ORDERS.prepare(
    `UPDATE recovery_codes SET used_at = ?3
       WHERE code_hash = ?1 AND user_id = ?2 AND used_at IS NULL`,
  )
    .bind(hash, userId, nowIso())
    .run()

  return (meta?.changes ?? 0) > 0
}

/** Everything the settings page needs to draw itself. */
export async function accountSettings(env: AuthEnv, user: User) {
  const row = await env.ORDERS.prepare(
    `SELECT pending_email, totp_confirmed_at, kdf_rounds FROM users WHERE id = ?1`,
  )
    .bind(user.id)
    .first<{ pending_email: string | null; totp_confirmed_at: string | null; kdf_rounds: number }>()

  const codes = await env.ORDERS.prepare(
    `SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ?1 AND used_at IS NULL`,
  )
    .bind(user.id)
    .first<{ n: number }>()

  return {
    user,
    pendingEmail: row?.pending_email ?? null,
    twoFactor: Boolean(row?.totp_confirmed_at),
    recoveryCodesLeft: codes?.n ?? 0,
    sessions: await activeSessionCount(env, user),
  }
}
