/**
 * How a merchant comes into existence, and who lets them in.
 *
 * Anyone may apply; nobody sells until a platform admin says so. That gate is
 * doing a job verification would otherwise do. There is no confirmation email
 * here — no mail key is bound on either environment, and a link to an inbox
 * proves less than a person reading the application does. What makes it safe
 * is that a `pending` merchant can do nothing at all: `scopedTo` refuses to
 * vend a repository for one, so an application made with somebody else's
 * address sits there inert until a human either approves it or does not.
 *
 * Three answers here are deliberately shaped rather than convenient:
 *
 * 1. The applicant does not choose the storefront address. When they did, the
 *    slug leaked whether an email was registered, and not through anything
 *    the response said: a successful registration consumed a globally unique,
 *    publicly probeable value, so two probes with one throwaway slug read
 *    202-then-409 only if the first had created a merchant. A leak carried by
 *    a side effect cannot be patched where it is observed, only by changing
 *    what the operation consumes. So registration mints `pending_<random>`,
 *    and the platform assigns the real address when it approves.
 *
 * 2. A taken email gets the same status *and* body a success does — 202
 *    either way. That equalisation used to be decorative, because the slug
 *    reopened the channel one request later. With the slug gone,
 *    registration's own answers are equalised across a new address and an
 *    existing one: there is nothing left in this response, or in what a
 *    second `registerMerchant` call can collide with, that tells the two
 *    apart.
 *
 *    The applicant still chooses the password, so an attacker can register
 *    a victim's address with a password of their own and try it at sign-in.
 *    That channel is read at sign-in, so `signIn` is where it is closed: a
 *    correct password for staff of a non-`active` merchant answers exactly
 *    as a wrong one does — status, body, KDF cost, failed-attempt count and
 *    backoff — so the answer is the same whether the probe created the
 *    account or the address already had one.
 *
 *    One residual is known and deferred, not closed: timing. A fresh
 *    application performs a batched write that a duplicate skips, so a
 *    duplicate answers faster by roughly one write. (Sign-in has a separate,
 *    documented trade-off of its own — see `signIn` on lockout.)
 *
 * 3. The merchant row and its owner are written in one batch. A merchant with
 *    no owner is an application nobody can ever claim.
 */
import {
  PBKDF2_ITERATIONS,
  KDF_ROUNDS,
  backoffSeconds,
  derive,
  fromB64,
  inSeconds,
  isPast,
  nowIso,
  randomToken,
  sameBytes,
  sha256,
  toB64,
} from './credentials'
import { readCookie } from './auth'
import { tooCommon } from './pwned'
import { id, type TenancyEnv } from './tenancy'
import { newTotpSecret, otpauthUri, verifyTotp } from './totp'

export interface StaffEnv extends TenancyEnv {}

export type StaffResult = {
  status: number
  body: Record<string, unknown>
  headers?: Record<string, string>
}

const str = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : null

const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)

/** What can appear in a storefront URL without being escaped into something else. */
const isSlug = (v: string) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(v)

/**
 * A placeholder address for an application nobody has read yet.
 *
 * The underscore is outside what `isSlug` accepts, so no approved address can
 * ever equal one of these. The random part is a 256-bit token folded to
 * lowercase alphanumerics — still around 200 bits, far past where two
 * applications could collide.
 */
const pendingSlug = () => `pending_${randomToken().toLowerCase().replace(/[^a-z0-9]/g, '')}`

/**
 * Twelve, where a shopper's is eight.
 *
 * A shopper's password protects their own order history. This one protects
 * every order placed with a merchant, and the prices they were placed at.
 * Upper bound because the KDF runs six chained passes over whatever it is
 * handed, and an unbounded input is a way to spend a worker's CPU budget.
 */
const MIN_PASSWORD = 12
const MAX_PASSWORD = 200

/**
 * The currency an application starts in.
 *
 * Not asked for on the form: it is the platform's, and changing it later
 * reinterprets nothing, because `products.currency` is written at the price's
 * side rather than read through the merchant.
 */
const DEFAULT_CURRENCY = 'USD'

/**
 * One sentence, used for both outcomes of an application.
 *
 * It has to be true whether a merchant was just created or the address
 * already had one, and useful in both. Waiting on a human is the only thing
 * that is.
 *
 * Frozen because every return site hands out this one object by reference —
 * which is what keeps the outcomes byte-identical — so a caller that mutated
 * it would change what the next applicant is told, whichever branch they hit.
 */
const APPLICATION_RECEIVED = Object.freeze({
  pending: true,
  message: 'Your application is with our team. We will be in touch once it is reviewed.',
})

const refuse = (error: string): StaffResult => ({ status: 400, body: { error } })

export async function registerMerchant(env: StaffEnv, body: unknown): Promise<StaffResult> {
  if (typeof body !== 'object' || body === null) return refuse('bad request')
  // A `slug` in the body is ignored rather than refused: callers written
  // against the old shape keep working, and get the address approval assigns.
  const p = body as { email?: unknown; name?: unknown; password?: unknown }

  const name = str(p.name, 120)
  if (!name) return refuse('Tell us what the business is called.')

  const email = str(p.email, 200)?.toLowerCase()
  if (!email || !isEmail(email)) return refuse('That email does not look right.')

  const password = typeof p.password === 'string' ? p.password : ''
  if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    return refuse(`Use between ${MIN_PASSWORD} and ${MAX_PASSWORD} characters.`)
  }

  // Length is a poor predictor and everybody knows it. Only the first five
  // characters of the SHA-1 leave this worker; see pwned.ts.
  const breached = await tooCommon(password)
  if (breached) return refuse(breached)

  /*
   * Hashed before the duplicate check rather than after it, so both paths
   * pay the same ~139ms KDF regardless of which one a request takes. That
   * does not make the two answers equally fast overall — see the header for
   * the write-time residual that remains — it only keeps the KDF itself
   * from being a second clock to read.
   */
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const hash = await derive(password, salt, KDF_ROUNDS)

  /*
   * The email answer comes from a SELECT, never from a failed INSERT.
   * "Is this address taken" is the one question this module refuses to
   * answer, so what decides it must not be the text of a database error.
   */
  const taken = await env.ORDERS.prepare(`SELECT 1 AS yes FROM staff WHERE email = ?1`)
    .bind(email)
    .first<{ yes: number }>()
  // 202, matching the status a fresh application gets below — not 200 or 409.
  // A status line is read before any body and needs no parsing; giving this
  // branch a status the other branch can't also produce would put the
  // enumeration oracle back one layer up, in the thing that's supposed to
  // close it.
  if (taken) return { status: 202, body: APPLICATION_RECEIVED }

  const merchantId = id('mch')
  try {
    await env.ORDERS.batch([
      env.ORDERS.prepare(
        `INSERT INTO merchants (id, slug, name, settlement_currency, status)
         VALUES (?1,?2,?3,?4,'pending')`,
      ).bind(merchantId, pendingSlug(), name, DEFAULT_CURRENCY),
      env.ORDERS.prepare(
        `INSERT INTO staff (id, email, scope, merchant_id, role, password_hash, password_salt,
                            iterations, kdf_rounds)
         VALUES (?1,?2,'merchant',?3,'owner',?4,?5,?6,?7)`,
      ).bind(id('stf'), email, merchantId, toB64(hash), toB64(salt), PBKDF2_ITERATIONS, KDF_ROUNDS),
    ])
  } catch (err) {
    // Two registrations racing for one address both pass the SELECT above,
    // and the loser lands here. It answers the way a taken address does:
    // losing a race must not be what tells the loser the address exists.
    // Any UNIQUE is read as that race, not just one naming staff.email: every
    // other unique value in this batch is random, so a message this cannot
    // parse is still the address, and 503 would be the oracle.
    if (/UNIQUE/i.test(String(err))) {
      // Still 202 — answering 503 on an email race would itself be an oracle
      // during the race. But a UNIQUE that isn't staff.email (an RNG fault,
      // or a future UNIQUE column) means nothing was stored and the
      // applicant was told otherwise; that must leave a trace somewhere.
      if (!/staff\.email/i.test(String(err))) {
        console.error('registration: unexpected UNIQUE, answered 202', err)
      }
      return { status: 202, body: APPLICATION_RECEIVED }
    }
    console.error('merchant registration failed', err)
    return { status: 503, body: { error: 'Could not take the application. Try again shortly.' } }
  }

  // Also 202, not 201: a status line that told the two outcomes apart would
  // still be a yes/no oracle even with an identical body, since it arrives
  // and can be read before the body does.
  return { status: 202, body: APPLICATION_RECEIVED }
}

/**
 * The gate. A pending application becomes a merchant that can trade, at the
 * storefront address the platform chose for it.
 *
 * @param staffId MUST come from the staff session row, and the caller MUST
 * have established that the session is platform-scoped. There is no check for
 * it here because there is nothing to check against: the argument is the only
 * claim about who is asking. The route is where that claim is made true.
 *
 * @param slug is untrusted request input and validated here. A taken one is a
 * plain 409: the caller is platform staff, who can already see every
 * merchant, so saying which address is in use tells them nothing new.
 *
 * The audit row is written here rather than by the tenancy wrapper, which
 * audits every repository call: this changes `merchants`, and the repository
 * does not reach that table. Both statements go in one batch, so there is no
 * window in which a merchant went active and no row says who did it.
 *
 * The UPDATE is conditional on `status = 'pending'` and the audit INSERT on
 * `changes() = 1`, rather than a SELECT deciding first: two admins approving
 * at once would both read `pending` and both write an audit row, one of them
 * recording an approval that changed nothing. `changes()` reads the UPDATE
 * because a batch runs its statements in order on one connection.
 */
export async function approveMerchant(
  env: StaffEnv,
  staffId: string,
  merchantId: string,
  slug: unknown,
): Promise<StaffResult> {
  const address = str(slug, 40)?.toLowerCase()
  if (!address || !isSlug(address)) {
    return refuse('A storefront address is lowercase letters, numbers and hyphens.')
  }

  let changed: number
  try {
    const [update, audit] = await env.ORDERS.batch([
      env.ORDERS.prepare(
        `UPDATE merchants SET status = 'active', slug = ?2 WHERE id = ?1 AND status = 'pending'`,
      ).bind(merchantId, address),
      env.ORDERS.prepare(
        `INSERT INTO audit_log (id, actor_id, actor_scope, merchant_id, action)
         SELECT ?1,?2,'platform',?3,'merchants.approve' WHERE changes() = 1`,
      ).bind(id('aud'), staffId, merchantId),
    ])
    changed = update.meta.changes
    // Relies on a batch running its statements in order on one connection —
    // true of D1 today. If that ever stopped holding, the UPDATE would
    // commit and the audit row would be silently skipped; this is what makes
    // that detectable instead of assumed.
    if (audit.meta.changes !== changed) {
      console.error('merchant approval: audit row did not match the update', {
        merchantId,
        changed,
        audited: audit.meta.changes,
      })
    }
  } catch (err) {
    // Settled by the constraint rather than a SELECT first, so two approvals
    // reaching for one address cannot both see it free.
    if (/UNIQUE/i.test(String(err)) && /merchants\.slug/i.test(String(err))) {
      return { status: 409, body: { error: 'That storefront address is taken.' } }
    }
    console.error('merchant approval failed', err)
    return { status: 503, body: { error: 'Could not approve the application. Try again shortly.' } }
  }

  // One answer for "no such application" and for "already approved", which
  // includes losing a race to another admin: the next move is the same either
  // way, which is to go and look.
  if (changed !== 1) {
    return { status: 404, body: { error: 'No pending application with that id.' } }
  }

  return { status: 200, body: { id: merchantId, status: 'active', slug: address } }
}

/* ------------------------------------------------------------------ sign-in */

/**
 * `__Host-` makes the browser refuse this cookie if it carries a Domain
 * attribute. Every *.workers.dev worker on this account is the same site, so
 * without it any sibling — an XSS on the storefront — could plant its own
 * session cookie here and sign the victim's console into the attacker's
 * account.
 */
export const STAFF_COOKIE = '__Host-nexus_staff'

/**
 * A working day, where a shopper's session lasts a month.
 *
 * Every sign-in costs a TOTP code as well as a password, so a short session
 * is cheap for the person holding the phone and expensive for anyone holding
 * a stolen cookie.
 */
const SESSION_SECONDS = 12 * 3600

/**
 * What a cookie is allowed to do.
 *
 * Only `active` carries a merchant id, so an enrolling session cannot be
 * handed to `scopedTo`: there is no argument to pass. That is the staff
 * table's paired CHECK again, applied to a type — the dangerous state is not
 * refused, it is unrepresentable.
 */
export type StaffSession =
  | { kind: 'enrolling'; staffId: string }
  | { kind: 'active'; staffId: string; merchantId: string | null; scope: 'merchant' | 'platform' }

/*
 * Which session row a StaffSession was read from.
 *
 * Confirming a code promotes one row, and the object is the only thing the
 * caller hands back. Keyed by identity rather than carried as a field, so a
 * session a caller built for itself — rather than one `staffSession` read
 * from a cookie — has no row to promote, and nothing about the token hash
 * can end up serialised into a response.
 */
const sessionRows = new WeakMap<StaffSession, string>()

/** Strict, not Lax: the console is same-origin with its own SPA and nothing links into it. */
const staffCookie = (token: string, maxAgeSeconds: number): string =>
  [
    `${STAFF_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ')

/*
 * Every refusal `signIn` can give a stranger, frozen and shared by reference
 * for the same reason APPLICATION_RECEIVED is: one object is what keeps the
 * outcomes byte-identical.
 */
const NO_MATCH: StaffResult = Object.freeze({
  status: 401,
  body: Object.freeze({ error: 'Those details do not match an account that can sign in.' }),
})

/*
 * Only for a caller already holding a session, which means the right
 * password: `signIn` never gives a stranger this — see its comment on
 * lockout.
 */
const LOCKED: StaffResult = Object.freeze({
  status: 423,
  body: Object.freeze({ error: 'Too many attempts. Wait a few minutes and try again.' }),
})

const SIGN_IN_AGAIN: StaffResult = Object.freeze({
  status: 401,
  body: Object.freeze({ error: 'Sign in again.' }),
})

const lockedNow = (lockedUntil: string | null) => Boolean(lockedUntil) && !isPast(lockedUntil)

/**
 * One more wrong guess against this account, password or code alike.
 *
 * The increment happens in SQL and the count is read back inside the same
 * batch, because a read-then-write in JS lets a burst of parallel guesses all
 * read the same count and all write count + 1 — a hundred guesses that cost
 * one. `backoffSeconds` stays the one definition of how long the wait is.
 *
 * `locked_until` is written on every call, NULL below the threshold, rather
 * than only when a wait begins: the attempt that engages the lock would
 * otherwise be the one answer a round trip slower than an unknown address.
 * NULL is safe because below the threshold nothing can have set it — the
 * count and the lock are only ever cleared together.
 */
async function recordFailure(env: StaffEnv, staffId: string): Promise<void> {
  const [, read] = await env.ORDERS.batch<{ failed_attempts: number }>([
    env.ORDERS.prepare(`UPDATE staff SET failed_attempts = failed_attempts + 1 WHERE id = ?1`).bind(
      staffId,
    ),
    env.ORDERS.prepare(`SELECT failed_attempts FROM staff WHERE id = ?1`).bind(staffId),
  ])
  const wait = backoffSeconds(read.results[0]?.failed_attempts ?? 0)
  await env.ORDERS.prepare(`UPDATE staff SET locked_until = ?2 WHERE id = ?1`)
    .bind(staffId, wait ? inSeconds(wait) : null)
    .run()
}

/**
 * Checks a password and, if it is right, issues a session that can do one
 * thing: prove a second factor.
 *
 * Every session starts `totp_pending = 1`, including the hundredth sign-in of
 * someone enrolled long ago. A password alone never produces a session that
 * acts.
 *
 * What a stranger can read here, and what they cannot:
 *
 * - An unknown address, a wrong password, and the right password for staff of
 *   a merchant that is not `active` all get NO_MATCH, after the same KDF.
 *   The third is the one that matters: registration lets the applicant pick
 *   the password, so an attacker can register a victim's address and sign in
 *   with their own choice. A pending account's correct password therefore
 *   counts as a failure too — it increments `failed_attempts` and engages
 *   backoff — so a probe-created account and a pre-existing one lock alike.
 *
 * - A locked account also gets NO_MATCH, even for the right password. An
 *   address with no account never locks, so a distinct lock status (the plan
 *   first said 423) would turn six wrong guesses into a way to learn whether
 *   a staff account exists. Decided in review of this task, matching the
 *   customer side for the same reason. The lock is still enforced — the
 *   right password is refused until the wait is over — it is just not
 *   announced. What that costs is a real owner who cannot tell "locked" from
 *   "mistyped"; waiting and retrying is the answer to both.
 *
 * Every refusal also pays the same KDF and the same three statements, the
 * unknown and locked ones running `recordFailure` against no row.
 *
 * @param _request is unused: the console route runs the per-IP throttle before
 * calling this, because the per-account backoff here cannot see a burst spread
 * across accounts.
 */
export async function signIn(env: StaffEnv, body: unknown, _request: Request): Promise<StaffResult> {
  const p = typeof body === 'object' && body !== null ? (body as { email?: unknown; password?: unknown }) : {}
  const email = str(p.email, 200)?.toLowerCase() ?? ''
  // An over-long password is derived as the empty string, which no account
  // has: the same cost as any other attempt, and a certain failure.
  const password =
    typeof p.password === 'string' && p.password.length <= MAX_PASSWORD ? p.password : ''

  const row = await env.ORDERS.prepare(
    `SELECT s.id, s.scope, s.password_hash, s.password_salt, s.kdf_rounds, s.locked_until,
            s.totp_confirmed_at, m.status AS merchant_status
       FROM staff s LEFT JOIN merchants m ON m.id = s.merchant_id
      WHERE s.email = ?1`,
  )
    .bind(email)
    .first<{
      id: string
      scope: 'merchant' | 'platform'
      password_hash: string
      password_salt: string
      kdf_rounds: number
      locked_until: string | null
      totp_confirmed_at: string | null
      merchant_status: string | null
    }>()

  // Derived before anything is decided, so no branch below is a faster way
  // to learn the answer. An unknown address pays the current cost.
  const attempt = await derive(
    password,
    row ? fromB64(row.password_salt) : new Uint8Array(16),
    row?.kdf_rounds ?? KDF_ROUNDS,
  )

  /*
   * An unknown address and a locked account run the statements a real
   * failure costs, against no row, so neither is the answer that skipped a
   * round trip. Guesses made while locked are not counted: the wait is what
   * slows them.
   */
  if (!row || lockedNow(row.locked_until)) {
    await recordFailure(env, '')
    return NO_MATCH
  }

  const mayTrade = row.scope === 'platform' || row.merchant_status === 'active'
  if (!sameBytes(attempt, fromB64(row.password_hash)) || !mayTrade) {
    await recordFailure(env, row.id)
    return NO_MATCH
  }

  /*
   * The failure count is left alone. It is cleared when a code verifies,
   * because a password that cleared it would let someone who has only the
   * password sign in again between code guesses and never meet the backoff.
   */
  const token = randomToken()
  await env.ORDERS.prepare(
    `INSERT INTO staff_sessions (token_hash, staff_id, expires_at, totp_pending) VALUES (?1,?2,?3,1)`,
  )
    .bind(await sha256(token), row.id, inSeconds(SESSION_SECONDS))
    .run()

  // Whether an authenticator is already set up is safe to say: only the
  // right password for a trading account reaches this line.
  return {
    status: 200,
    body: { totpRequired: true, enrolled: Boolean(row.totp_confirmed_at) },
    headers: { 'Set-Cookie': staffCookie(token, SESSION_SECONDS) },
  }
}

/**
 * Who is behind this cookie, and what they may do.
 *
 * Null for no cookie, an unknown token and an expired one alike: the caller's
 * answer to all three is the same.
 */
export async function staffSession(env: StaffEnv, request: Request): Promise<StaffSession | null> {
  const token = readCookie(request, STAFF_COOKIE)
  if (!token) return null

  const tokenHash = await sha256(token)
  const row = await env.ORDERS.prepare(
    `SELECT s.id, s.scope, s.merchant_id, ss.expires_at, ss.totp_pending
       FROM staff_sessions ss JOIN staff s ON s.id = ss.staff_id
      WHERE ss.token_hash = ?1`,
  )
    .bind(tokenHash)
    .first<{
      id: string
      scope: 'merchant' | 'platform'
      merchant_id: string | null
      expires_at: string
      totp_pending: number
    }>()
  if (!row || isPast(row.expires_at)) return null

  // Anything other than an explicit 0 is pending: this is the one column
  // that decides whether a session may act, so it fails closed.
  const session: StaffSession =
    row.totp_pending === 0
      ? { kind: 'active', staffId: row.id, merchantId: row.merchant_id, scope: row.scope }
      : { kind: 'enrolling', staffId: row.id }
  sessionRows.set(session, tokenHash)
  return session
}

/**
 * Ends this session server-side as well as in the browser.
 *
 * Clearing the cookie alone would leave a token that still works if it was
 * captured, which is the case that matters. Any session, enrolling or active:
 * someone who stops halfway through enrolment should be able to walk away.
 */
export async function signOut(env: StaffEnv, request: Request): Promise<StaffResult> {
  const token = readCookie(request, STAFF_COOKIE)
  if (token) {
    await env.ORDERS.prepare(`DELETE FROM staff_sessions WHERE token_hash = ?1`)
      .bind(await sha256(token))
      .run()
  }
  return { status: 200, body: { ok: true }, headers: { 'Set-Cookie': staffCookie('', 0) } }
}

/**
 * A new TOTP secret, for someone who has never confirmed one.
 *
 * Refused once one is confirmed. Every sign-in is an enrolling session, so a
 * secret minted on request would let a password alone replace the second
 * factor and then confirm the replacement.
 */
export async function beginTotpEnrolment(env: StaffEnv, session: StaffSession): Promise<StaffResult> {
  if (!sessionRows.has(session)) return SIGN_IN_AGAIN

  const row = await env.ORDERS.prepare(`SELECT email, totp_secret, totp_confirmed_at FROM staff WHERE id = ?1`)
    .bind(session.staffId)
    .first<{ email: string; totp_secret: string | null; totp_confirmed_at: string | null }>()
  if (!row) return SIGN_IN_AGAIN

  const ALREADY = {
    status: 409,
    body: { error: 'An authenticator is already set up. Enter the code it shows.' },
  }
  if (row.totp_confirmed_at) return ALREADY

  // A reload after scanning must not orphan the entry already in the app —
  // every code it shows would then be wrong, and five of those lock the
  // account. Handing the same secret back is no weaker: until a code
  // confirms, the password is the only factor this account has either way.
  if (row.totp_secret) {
    return { status: 200, body: { secret: row.totp_secret, uri: otpauthUri(row.email, row.totp_secret) } }
  }

  // Conditional on still being unconfirmed, so a confirmation that lands
  // between the read above and this write cannot be overwritten.
  const secret = newTotpSecret()
  const { meta } = await env.ORDERS.prepare(
    `UPDATE staff SET totp_secret = ?2 WHERE id = ?1 AND totp_confirmed_at IS NULL`,
  )
    .bind(session.staffId, secret)
    .run()
  if (meta.changes !== 1) return ALREADY

  return { status: 200, body: { secret, uri: otpauthUri(row.email, secret) } }
}

/**
 * Checks a code and, if it is right, lets this session act.
 *
 * The same call serves first enrolment and every later sign-in: either way it
 * is a code checked against the stored secret. Only the session that
 * presented the code is promoted; another session for the same person — which
 * may be someone else holding only the password — stays pending.
 */
export async function confirmTotpEnrolment(
  env: StaffEnv,
  session: StaffSession,
  body: unknown,
): Promise<StaffResult> {
  const tokenHash = sessionRows.get(session)
  if (!tokenHash) return SIGN_IN_AGAIN

  const code =
    typeof body === 'object' && body !== null ? str((body as { code?: unknown }).code, 40) : null
  if (!code) return refuse('Enter the six-digit code.')

  const row = await env.ORDERS.prepare(
    `SELECT totp_secret, locked_until FROM staff WHERE id = ?1`,
  )
    .bind(session.staffId)
    .first<{ totp_secret: string | null; locked_until: string | null }>()
  if (!row?.totp_secret) return refuse('Start again — there is no authenticator being set up.')
  if (lockedNow(row.locked_until)) return LOCKED

  if (!(await verifyTotp(row.totp_secret, code))) {
    await recordFailure(env, session.staffId)
    return refuse('That code is not right. Check your phone’s clock and try the next one.')
  }

  /*
   * The staff UPDATE matches only the secret the code was checked against,
   * and the session is promoted only if it did: an unconfirmed secret
   * replaced by another session between the check and this write must not be
   * the one that gets confirmed. `changes()` reads the staff UPDATE because a
   * batch runs its statements in order on one connection, as approval relies
   * on too.
   */
  const [, promoted] = await env.ORDERS.batch([
    env.ORDERS.prepare(
      `UPDATE staff SET totp_confirmed_at = COALESCE(totp_confirmed_at, ?2),
                        failed_attempts = 0, locked_until = NULL
        WHERE id = ?1 AND totp_secret = ?3`,
    ).bind(session.staffId, nowIso(), row.totp_secret),
    env.ORDERS.prepare(
      `UPDATE staff_sessions SET totp_pending = 0
        WHERE token_hash = ?1 AND staff_id = ?2 AND expires_at > ?3 AND changes() = 1`,
    ).bind(tokenHash, session.staffId, nowIso()),
  ])
  if (promoted.meta.changes !== 1) return SIGN_IN_AGAIN

  return { status: 200, body: { ok: true } }
}
