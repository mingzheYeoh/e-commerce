/**
 * The only way into merchant-scoped data.
 *
 * Isolation here is structural rather than disciplinary: there is no function
 * that takes an optional merchant id, and no boolean that widens a query. A
 * caller either holds a merchant-scoped repository or a platform one, and the
 * predicate is attached where the repository is built — not where it is used.
 *
 * SQLite has no row-level security, so this layer is the enforcement point.
 * That is a deliberate trade recorded in the design: Postgres would move the
 * check closer to the data, at the cost of a JWT-minting step that fails in
 * the same way the check was meant to prevent.
 */
import type { OrdersEnv } from './orders'

export interface TenancyEnv extends OrdersEnv {}

export type Scope =
  | { kind: 'merchant'; merchantId: string; staffId: string }
  | { kind: 'platform'; staffId: string }

export interface ProductRow {
  id: string
  merchant_id: string
  sku: string
  title: string
  brand: string
  category: string
  price_minor: number
  currency: string
  status: string
  stock_count: number
  specs_summary: string
  specs: string
  colorways: string
  media: string
}

export interface NewProduct {
  sku: string
  title: string
  brand: string
  category: string
  priceMinor: number
}

export interface ProductPatch {
  title?: string
  priceMinor?: number
  status?: string
  stockCount?: number
  category?: string
  specsSummary?: string[]
  specs?: { label: string; value: string }[]
}

export interface Repository {
  products: {
    list(): Promise<ProductRow[]>
    get(id: string): Promise<ProductRow | null>
    create(input: NewProduct): Promise<ProductRow>
    update(id: string, patch: ProductPatch): Promise<ProductRow | null>
    /**
     * Replaces `media` only if it still equals `expected`, so two uploads
     * racing on one product cannot drop each other's photo. Null when the row
     * is not this scope's, or when it changed underneath the caller.
     *
     * Separate from `update` on purpose: ProductPatch is what a request may
     * say, and media URLs are never something a request says — the console
     * mints them from the storage keys it wrote.
     */
    setMedia(id: string, media: string, expected: string): Promise<ProductRow | null>
  }
}

/** Exported so staff-auth mints `mch_`/`stf_` the one way this worker mints ids. */
export const id = (prefix: string) =>
  `${prefix}_${[...crypto.getRandomValues(new Uint8Array(12))]
    .map((b) => b.toString(36).padStart(2, '0'))
    .join('')
    .slice(0, 20)}`

/**
 * The tenant clause and its binding, or nothing at all.
 *
 * Merchant scope yields the predicate; platform scope yields null and the
 * clause is genuinely absent from the SQL rather than satisfied by a null
 * binding. `WHERE (? IS NULL OR merchant_id = ?)` would be shorter and is the
 * same "null means everything" shape this design rejected in the staff table.
 */
const tenant = (scope: Scope) =>
  scope.kind === 'merchant' ? (['merchant_id = ?', scope.merchantId] as const) : null

/**
 * Assembles clauses into a WHERE and its bindings, in order.
 *
 * Anonymous `?` rather than the numbered `?1` used elsewhere in this worker.
 * The tenant clause is present or absent, and numbering that shifts with it is
 * exactly where an off-by-one silently drops the predicate.
 */
function where(parts: (readonly [string, unknown] | null)[]): { sql: string; args: unknown[] } {
  const live = parts.filter((p): p is readonly [string, unknown] => p !== null)
  return {
    sql: live.length ? ` WHERE ${live.map(([clause]) => clause).join(' AND ')}` : '',
    args: live.map(([, value]) => value),
  }
}

/** Integer columns must be safe integers or SQLite stores them as REAL. */
function assertIntegerMinor(value: number, field: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${field} must be a whole number of minor units, not ${String(value)}`)
  }
}

/** Methods that only read. Everything else is a write, and every write is an event. */
const READS = new Set(['products.list', 'products.get'])

/**
 * Whether this call is worth a row.
 *
 * Every write by anyone, and every platform read. A merchant reading their own
 * data is not an event, and recording it would bury the entries that are.
 *
 * Listing the reads rather than the writes so that forgetting to update this
 * set costs a surplus row, not a missing one. A method added without a thought
 * for auditing is a write until someone says otherwise; a missing row cannot be
 * added later, because audit_log is append-only.
 */
const worthAuditing = (scope: Scope, dotted: string): boolean =>
  scope.kind === 'platform' || !READS.has(dotted)

/**
 * One audit row.
 *
 * Numbered `?1..?6` here, against the anonymous `?` this file argues for
 * above: a fixed six-column INSERT has no clause that appears or disappears,
 * so there is no numbering to shift under an off-by-one.
 */
async function record(
  env: TenancyEnv,
  scope: Scope,
  dotted: string,
  merchantId: string | null,
  subject: string | null,
): Promise<void> {
  await env.ORDERS.prepare(
    `INSERT INTO audit_log (id, actor_id, actor_scope, merchant_id, action, subject)
     VALUES (?1,?2,?3,?4,?5,?6)`,
  )
    .bind(id('aud'), scope.staffId, scope.kind, merchantId, dotted, subject)
    .run()
}

function build(env: TenancyEnv, scope: Scope): Repository {
  /*
   * A local closure rather than `this.get(...)`. `this` inside an object
   * literal's methods is bound by call site, not by where the method was
   * defined — `platformRepo.products.update.call(merchantRepo.products, ...)`
   * would run this lookup under one scope and the write under another, and
   * destructuring a method off the object (`const { update } = repo.products`)
   * loses `this` entirely and throws. Closing over `get` instead means every
   * caller of `create`/`update` gets the same scope no matter how they're
   * invoked.
   */
  const get = async (productId: string) => {
    const w = where([['id = ?', productId], tenant(scope)])
    return env.ORDERS.prepare(`SELECT * FROM products${w.sql}`)
      .bind(...w.args)
      .first<ProductRow>()
  }

  const raw: Repository = {
    products: {
      async list() {
        const w = where([tenant(scope)])
        const { results } = await env.ORDERS.prepare(
          `SELECT * FROM products${w.sql} ORDER BY created_at DESC`,
        )
          .bind(...w.args)
          .all<ProductRow>()
        return results ?? []
      },

      get,

      async create(input: NewProduct) {
        /*
         * The merchant comes from the scope, never from the payload. A caller
         * that could name its own merchant_id could write into somebody
         * else's catalogue — which is the same hole as a missing predicate,
         * pointed the other way.
         */
        if (scope.kind !== 'merchant') {
          throw new Error('platform scope cannot create a product on a merchant behalf')
        }
        assertIntegerMinor(input.priceMinor, 'priceMinor')

        /*
         * Currency is the merchant's settlement currency, never the payload's.
         * Merchants price in what they're settled in; a payload-supplied
         * currency would create a conversion leg with no rate behind it.
         */
        const merchant = await env.ORDERS.prepare(
          `SELECT settlement_currency FROM merchants WHERE id = ?`,
        )
          .bind(scope.merchantId)
          .first<{ settlement_currency: string }>()
        // This branch is unreachable through the module's public entry points
        // (scopedTo and platformWide); scopedTo verifies the merchant exists before
        // handing out a Repository. The guard tests existence, not status, and would
        // only catch a merchant row deleted after vending. No DELETE FROM merchants
        // path exists in this codebase today, but the guard remains for developers
        // who might add one.
        if (!merchant) {
          throw new Error('cannot price a product for a merchant that does not exist')
        }

        const productId = id('prd')
        await env.ORDERS.prepare(
          `INSERT INTO products (id, merchant_id, sku, title, brand, category, price_minor, currency, status)
           VALUES (?,?,?,?,?,?,?,?,'draft')`,
        )
          .bind(
            productId,
            scope.merchantId,
            input.sku,
            input.title,
            input.brand,
            input.category,
            input.priceMinor,
            merchant.settlement_currency,
          )
          .run()
        return (await get(productId))!
      },

      async update(productId: string, patch: ProductPatch) {
        if (patch.priceMinor !== undefined) assertIntegerMinor(patch.priceMinor, 'priceMinor')
        if (patch.stockCount !== undefined) assertIntegerMinor(patch.stockCount, 'stockCount')

        const existing = await get(productId)
        if (!existing) return null

        // SET bindings come first and the WHERE bindings after, because
        // anonymous `?` binds by position within the whole statement.
        const w = where([['id = ?', productId], tenant(scope)])
        await env.ORDERS.prepare(
          `UPDATE products
              SET title = ?, price_minor = ?, status = ?, stock_count = ?,
                  category = ?, specs_summary = ?, specs = ?,
                  updated_at = datetime('now')${w.sql}`,
        )
          .bind(
            patch.title ?? existing.title,
            patch.priceMinor ?? existing.price_minor,
            patch.status ?? existing.status,
            patch.stockCount ?? existing.stock_count,
            patch.category ?? existing.category,
            patch.specsSummary ? JSON.stringify(patch.specsSummary) : existing.specs_summary,
            patch.specs ? JSON.stringify(patch.specs) : existing.specs,
            ...w.args,
          )
          .run()
        return get(productId)
      },

      async setMedia(productId: string, media: string, expected: string) {
        const w = where([['id = ?', productId], ['media = ?', expected], tenant(scope)])
        const { meta } = await env.ORDERS.prepare(
          `UPDATE products SET media = ?, updated_at = datetime('now')${w.sql}`,
        )
          .bind(media, ...w.args)
          .run()
        return meta.changes === 1 ? get(productId) : null
      },
    },
  }

  /*
   * Auditing is applied by wrapping rather than by a line inside each method.
   * A line inside each method is a line that can be left out of the next one;
   * the wrapper covers every async method added to an existing group — it
   * does not reach a nested group (that throws at construction time with a
   * named message), a class instance (its methods aren't own enumerable
   * properties and are lost entirely), or a synchronous method (it becomes
   * async without complaint).
   *
   * Ceiling: the write and its audit row are not atomic. `fn` is awaited and
   * committed before `record` runs, so a write can succeed while its audit
   * row does not: the caller is told the call failed, yet the data already
   * changed. Making the two atomic would mean every write carrying its own
   * `env.ORDERS.batch([...])` so the row and the change land in one
   * transaction — done in each write method instead of here, which is
   * exactly the coverage this wrapper trades away. `record`'s own failure is
   * still not swallowed: see the catch below.
   *
   * One group at a time, named explicitly at the call site below, so that the
   * result is an object literal TypeScript can check against Repository. A
   * sweep over Object.entries(raw) produced an index-signature type that only
   * a cast could turn back into a Repository — and a cast is exactly what
   * would have let a new group be wrapped but never declared.
   */
  const wrap = (group: string, methods: object) =>
    Object.fromEntries(
      Object.entries(methods as Record<string, (...a: never[]) => Promise<unknown>>).map(
        ([name, fn]) => {
          // A nested group would pass through this map untouched and its methods
          // would work, unaudited and invisible to methodNames(). Failing here is
          // the point: an unaudited path that quietly works is what this wrapper
          // exists to prevent. This branch is unreachable through the module's public
          // entry points (scopedTo and platformWide); the guard exists for developers
          // editing the repository literal below.
          if (fn !== null && typeof fn === 'object') {
            throw new Error(`audit wrapper does not support nested groups: ${group}.${name}`)
          }
          // A non-function property is left exactly as it is rather than being
          // turned into one.
          if (typeof fn !== 'function') return [name, fn]
          return [
            name,
            async (...args: never[]) => {
              const result = await fn.apply(methods, args)
              const dotted = `${group}.${name}`
              if (worthAuditing(scope, dotted)) {
                // An id argument where there is one, and otherwise whatever
                // the call produced: create's first argument is a payload,
                // so the one row that records a thing coming into existence
                // would be the only one unable to name it.
                const subject =
                  typeof args[0] === 'string'
                    ? (args[0] as string)
                    : ((result as { id?: string } | null)?.id ?? null)
                // ponytail: a platform list across N merchants writes N rows.
                // The upgrade if that volume ever matters is one row plus a
                // `detail` JSON of ids — but only alongside a merchant-facing
                // query that reads it, or the row becomes unfindable again.
                const touched: (string | null)[] =
                  scope.kind === 'merchant'
                    ? [scope.merchantId]
                    : Array.isArray(result)
                      ? [
                          ...new Set(
                            (result as { merchant_id: string }[]).map((r) => r.merchant_id),
                          ),
                        ]
                      : [(result as { merchant_id?: string } | null)?.merchant_id ?? null]
                try {
                  for (const m of touched) await record(env, scope, dotted, m, subject)
                } catch (err) {
                  // The call already did its work (read or write), and the
                  // caller is about to be told it failed. Nothing in the
                  // database will ever hold this row, so the log stream is
                  // the only place it can survive — printed in full before
                  // the rethrow.
                  console.error('audit record lost, call already completed', {
                    actor: scope.staffId,
                    scope: scope.kind,
                    merchantId: touched,
                    action: dotted,
                    subject,
                    error: err,
                  })
                  throw err
                }
              }
              return result
            },
          ]
        },
      ),
    )

  const audited: Repository = {
    products: wrap('products', raw.products) as Repository['products'],
  }
  return audited
}

/**
 * A merchant's own data, and nothing else.
 *
 * Async because it verifies the merchant is active before handing anything
 * back. `merchants.status` had a CHECK from the first migration and no reader
 * until staff could sign in — a dormant constraint whose default answer, once
 * the question became reachable, was "yes, go ahead".
 *
 * The check lives here rather than in a route so that a route added later gets
 * it without its author knowing the rule exists.
 *
 * A Repository vended while the merchant was active remains valid even after
 * the merchant is suspended—the check is at the door, not on each operation.
 * Callers must obtain a fresh Repository per request and never cache it across
 * requests. The per-request SELECT is the authorization itself, not overhead
 * to optimize away.
 *
 * @param merchantId MUST come from the staff session row, never a request
 * body. This does not verify staffId belongs to merchantId — the pair is
 * trusted as given, and until branded ids land this comment is the whole
 * defence against a caller that supplies its own.
 */
export const scopedTo = async (
  env: TenancyEnv,
  merchantId: string,
  staffId: string,
): Promise<Repository> => {
  const row = await env.ORDERS.prepare(`SELECT status FROM merchants WHERE id = ?`)
    .bind(merchantId)
    .first<{ status: string }>()
  if (row?.status !== 'active') {
    // One message for "no such merchant" and for "suspended": the caller's
    // only sensible response to both is the same, and a distinction here
    // would eventually be surfaced as one.
    throw new Error(`merchant ${merchantId} is not active`)
  }
  return build(env, { kind: 'merchant', merchantId, staffId })
}

/**
 * Everything, for platform staff.
 *
 * A separate named door rather than a boolean argument, so that reading a call
 * site tells you which one it is without following a variable.
 */
export const platformWide = async (env: TenancyEnv, staffId: string): Promise<Repository> =>
  build(env, { kind: 'platform', staffId })

/**
 * The dotted names of every method on a repository.
 *
 * Exists for the completeness test: a new method that nobody wrote an
 * isolation case for should turn the suite red on its own.
 */
export function methodNames(repo: Repository): string[] {
  return Object.entries(repo).flatMap(([group, methods]) =>
    Object.keys(methods as object).map((name) => `${group}.${name}`),
  )
}
