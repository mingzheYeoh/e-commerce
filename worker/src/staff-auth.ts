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
 * Two answers here are deliberately shaped rather than convenient:
 *
 * 1. A taken email gets the same body a success does. A registration form
 *    that distinguishes tells a stranger which addresses have merchant
 *    accounts, and that is worth more to them than the form is.
 *
 * 2. The merchant row and its owner are written in one batch. A merchant with
 *    no owner is an application nobody can ever claim — and nobody can ever
 *    clear, because the slug it holds is unique.
 */
import { PBKDF2_ITERATIONS, KDF_ROUNDS, derive, toB64 } from './credentials'
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
  const p = body as { email?: unknown; name?: unknown; slug?: unknown; password?: unknown }

  const name = str(p.name, 120)
  if (!name) return refuse('Tell us what the business is called.')

  const email = str(p.email, 200)?.toLowerCase()
  if (!email || !isEmail(email)) return refuse('That email does not look right.')

  const slug = str(p.slug, 40)?.toLowerCase()
  if (!slug || !isSlug(slug)) {
    return refuse('A storefront address is lowercase letters, numbers and hyphens.')
  }

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
   * The slug is the opposite: the applicant chose it, is entitled to know it
   * collided, and the unique constraint below is what actually settles it.
   */
  const taken = await env.ORDERS.prepare(`SELECT 1 AS yes FROM staff WHERE email = ?1`)
    .bind(email)
    .first<{ yes: number }>()
  if (taken) return { status: 202, body: APPLICATION_RECEIVED }

  const merchantId = id('mch')
  try {
    await env.ORDERS.batch([
      env.ORDERS.prepare(
        `INSERT INTO merchants (id, slug, name, settlement_currency, status)
         VALUES (?1,?2,?3,?4,'pending')`,
      ).bind(merchantId, slug, name, DEFAULT_CURRENCY),
      env.ORDERS.prepare(
        `INSERT INTO staff (id, email, scope, merchant_id, role, password_hash, password_salt,
                            iterations, kdf_rounds)
         VALUES (?1,?2,'merchant',?3,'owner',?4,?5,?6,?7)`,
      ).bind(id('stf'), email, merchantId, toB64(hash), toB64(salt), PBKDF2_ITERATIONS, KDF_ROUNDS),
    ])
  } catch (err) {
    if (/UNIQUE/i.test(String(err))) {
      // A race on the address lands here, and answers the way a taken address
      // does. Anything else that is unique is the slug — including a message
      // this cannot read, which is the safe way round to be wrong.
      return /staff\.email/i.test(String(err))
        ? { status: 202, body: APPLICATION_RECEIVED }
        : { status: 409, body: { error: 'That storefront address is taken. Pick another.' } }
    }
    console.error('merchant registration failed', err)
    return { status: 503, body: { error: 'Could not take the application. Try again shortly.' } }
  }

  return { status: 201, body: APPLICATION_RECEIVED }
}

/**
 * The gate. A pending application becomes a merchant that can trade.
 *
 * @param staffId MUST come from the staff session row, and the caller MUST
 * have established that the session is platform-scoped. There is no check for
 * it here because there is nothing to check against: the argument is the only
 * claim about who is asking. The route is where that claim is made true.
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
): Promise<StaffResult> {
  const merchant = await env.ORDERS.prepare(`SELECT status FROM merchants WHERE id = ?1`)
    .bind(merchantId)
    .first<{ status: string }>()

  // One answer for "no such application" and for "already approved": the
  // admin's next move is the same either way, which is to go and look.
  if (merchant?.status !== 'pending') {
    return { status: 404, body: { error: 'No pending application with that id.' } }
  }

  await env.ORDERS.batch([
    env.ORDERS.prepare(`UPDATE merchants SET status = 'active' WHERE id = ?1`).bind(merchantId),
    env.ORDERS.prepare(
      `INSERT INTO audit_log (id, actor_id, actor_scope, merchant_id, action)
       VALUES (?1,?2,'platform',?3,'merchants.approve')`,
    ).bind(id('aud'), staffId, merchantId),
  ])

  return { status: 200, body: { id: merchantId, status: 'active' } }
}
