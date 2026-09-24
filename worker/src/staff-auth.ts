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
 *    reopened the channel one request later. With nothing left for an
 *    applicant to choose, there is nothing a second request can collide
 *    with, so one request or two read the same answer whether or not the
 *    address has an account. What remains is timing: a fresh application
 *    performs a batched write that a duplicate skips, so a duplicate answers
 *    faster by roughly one write. That residual is known and deferred; the
 *    channel is narrowed to a clock, not shut.
 *
 * 3. The merchant row and its owner are written in one batch. A merchant with
 *    no owner is an application nobody can ever claim.
 */
import { PBKDF2_ITERATIONS, KDF_ROUNDS, derive, randomToken, toB64 } from './credentials'
import { tooCommon } from './pwned'
import { id, type TenancyEnv } from './tenancy'

export interface StaffEnv extends TenancyEnv {}

export type StaffResult = { status: number; body: Record<string, unknown> }

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
 */
const APPLICATION_RECEIVED = {
  pending: true,
  message: 'Your application is with our team. We will be in touch once it is reviewed.',
}

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
    return refuse(`Use at least ${MIN_PASSWORD} characters.`)
  }

  // Length is a poor predictor and everybody knows it. Only the first five
  // characters of the SHA-1 leave this worker; see pwned.ts.
  const breached = await tooCommon(password)
  if (breached) return refuse(breached)

  /*
   * Hashed before the duplicate check rather than after it, so that both
   * answers cost the same ~139ms. The two responses are identical by design;
   * a taken address that comes back in a fraction of the time is the same
   * oracle, read off a clock instead of off the page.
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

  const merchant = await env.ORDERS.prepare(`SELECT status FROM merchants WHERE id = ?1`)
    .bind(merchantId)
    .first<{ status: string }>()

  // One answer for "no such application" and for "already approved": the
  // admin's next move is the same either way, which is to go and look.
  if (merchant?.status !== 'pending') {
    return { status: 404, body: { error: 'No pending application with that id.' } }
  }

  try {
    await env.ORDERS.batch([
      env.ORDERS.prepare(`UPDATE merchants SET status = 'active', slug = ?2 WHERE id = ?1`).bind(
        merchantId,
        address,
      ),
      env.ORDERS.prepare(
        `INSERT INTO audit_log (id, actor_id, actor_scope, merchant_id, action)
         VALUES (?1,?2,'platform',?3,'merchants.approve')`,
      ).bind(id('aud'), staffId, merchantId),
    ])
  } catch (err) {
    // Settled by the constraint rather than a SELECT first, so two approvals
    // reaching for one address cannot both see it free.
    if (/UNIQUE/i.test(String(err)) && /merchants\.slug/i.test(String(err))) {
      return { status: 409, body: { error: 'That storefront address is taken.' } }
    }
    throw err
  }

  return { status: 200, body: { id: merchantId, status: 'active', slug: address } }
}
