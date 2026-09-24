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
  /**
   * Orders that hold at least one line in scope, and only those lines. A
   * merchant's view of a shared order is its own lines and their sum — never
   * the order's total, which includes other merchants' goods.
   */
  orders: {
    list(range: OrderRange): Promise<OrderSummary[]>
    get(id: string): Promise<OrderDetail | null>
  }
  stats: {
    overview(): Promise<Overview>
  }
}

/**
 * The platform's repository: everything a merchant's has, plus the groups no
 * merchant repository carries at all. Suspending a merchant is not something
 * a merchant repository refuses — it is something it does not have.
 */
export interface PlatformRepository extends Repository {
  merchants: {
    list(): Promise<MerchantSummary[]>
    /** active → suspended. Throws when the merchant is not active, so no audit row claims it happened. */
    suspend(id: string): Promise<{ merchant_id: string; status: 'suspended' }>
    /** suspended → active. Never pending → active: approval is its own flow. */
    restore(id: string): Promise<{ merchant_id: string; status: 'active' }>
  }
  audit: {
    list(filter: { merchantId: string | null; page: number }): Promise<AuditPage>
  }
}

/**
 * An amount of one currency. Totals are always a list of these: two
 * currencies are never added together, because nothing here has a rate.
 */
export interface Amount {
  currency: string
  minor: number
}

/** Inclusive UTC calendar dates, `YYYY-MM-DD`, already validated by the caller. */
export interface OrderRange {
  from: string
  to: string
}

export interface OrderSummary {
  id: string
  created_at: string
  method: string
  payment_status: string
  /** Units of in-scope lines. */
  items: number
  totals: Amount[]
}

/**
 * What a seller needs to fulfil their lines: who, where, how fast. No email
 * and no phone — the platform owns the customer relationship, and a seller
 * who ships to the address needs neither.
 */
export interface OrderDetail {
  id: string
  created_at: string
  method: string
  payment_status: string
  ship_name: string
  ship_country: string
  ship_line1: string
  ship_line2: string
  ship_city: string
  ship_state: string
  ship_postal: string
  lines: {
    product_id: string
    sku: string
    title: string
    variant: string
    qty: number
    unit_price_cents: number
    currency: string
  }[]
  totals: Amount[]
}

export interface Overview {
  /** Calendar days in UTC: today, the last 7 including today, the last 30. */
  revenue: { today: Amount[]; week: Amount[]; month: Amount[] }
  orders: { today: number; week: number; month: number }
  /** Exactly 30 entries, oldest first, a day with no sales included as empty. */
  trend: { day: string; revenue: Amount[] }[]
  /** Last 30 days, top five per currency — a ranking across currencies would compare units. */
  top: { product_id: string; title: string; currency: string; minor: number; qty: number }[]
  lowStock: { id: string; title: string; stock_count: number }[]
  products: { draft: number; published: number; archived: number }
}

export interface MerchantSummary {
  merchant_id: string
  name: string
  slug: string
  status: string
  created_at: string
  product_count: number
  /** Last 30 days. */
  revenue: Amount[]
}

export interface AuditPage {
  /** The merchant filtered to, so the read of their log is recorded against them. */
  merchant_id: string | null
  page: number
  hasMore: boolean
  entries: {
    id: string
    at: string
    actor_id: string
    actor_email: string | null
    actor_scope: string
    merchant_id: string | null
    merchant_name: string | null
    action: string
    subject: string | null
  }[]
}

/** Published and at or under this many units: the overview's low-stock alert. */
export const LOW_STOCK = 5
/** One audit page. */
export const AUDIT_PAGE = 50

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
const tenant = (scope: Scope, column = 'merchant_id') =>
  scope.kind === 'merchant' ? ([`${column} = ?`, scope.merchantId] as const) : null

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
const READS = new Set(['products.list', 'products.get', 'orders.list', 'orders.get', 'stats.overview'])

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
const wrapGroup = (env: TenancyEnv, scope: Scope, group: string, methods: object) =>
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
                          // `?? null`: a row that spans merchants (a platform
                          // order summary) has no merchant_id, and D1 refuses
                          // to bind undefined.
                          (result as { merchant_id?: string }[]).map((r) => r.merchant_id ?? null),
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

/*
 * Sales are order lines of paid orders. Revenue is merchandise: qty times the
 * frozen unit price. Shipping and tax belong to the order, not to any one
 * merchant, so they are in nobody's revenue — the platform's included, which
 * keeps the platform figure the sum of the merchant figures.
 *
 * order_lines has no currency column. unit_price_cents is copied from
 * products.price_minor at checkout, and that price's currency is
 * products.currency — written once from the merchant at create and never
 * updated, on a row nothing deletes. So the join recovers each line's currency
 * exactly. orders.currency is NOT it: that is the shopper's display choice.
 * A line whose product row is somehow gone reads as XXX, ISO 4217's "no
 * currency", rather than being guessed into someone's USD.
 */
const SALES = `FROM order_lines l
  JOIN orders o ON o.id = l.order_id
  LEFT JOIN products p ON p.id = l.product_id`
const CURRENCY = `COALESCE(p.currency, 'XXX')`
const PAID = ['o.payment_status = ?', 'succeeded'] as const

/**
 * A UTC calendar date `days` before today. created_at is SQLite's UTC
 * `YYYY-MM-DD HH:MM:SS`, so `created_at >= '2026-09-18'` compares as text.
 */
export const utcDay = (days = 0, now = Date.now()) =>
  new Date(now - days * 86_400_000).toISOString().slice(0, 10)

/** Rows already summed per currency by SQL, keyed without adding across. */
const amountsOf = (rows: { currency: string; minor: number }[]): Amount[] =>
  rows.map(({ currency, minor }) => ({ currency, minor }))

/** Merchants a platform repository can act on that no merchant repository has. */
function platformOnly(env: TenancyEnv): Omit<PlatformRepository, keyof Repository> {
  const transition = async (merchantId: string, from: string, to: string) => {
    const { meta } = await env.ORDERS.prepare(`UPDATE merchants SET status = ? WHERE id = ? AND status = ?`)
      .bind(to, merchantId, from)
      .run()
    // Thrown rather than returned as null: the wrapper records the call once
    // it returns, and a refused suspension must not leave a row saying
    // 'merchants.suspend' happened.
    if (meta.changes !== 1) throw new Error(`merchant ${merchantId} is not ${from}`)
  }

  return {
    merchants: {
      async list() {
        const [merchants, revenue] = await Promise.all([
          env.ORDERS.prepare(
            `SELECT m.id AS merchant_id, m.name, m.slug, m.status, m.created_at,
                    (SELECT COUNT(*) FROM products p WHERE p.merchant_id = m.id) AS product_count
               FROM merchants m
              ORDER BY m.created_at DESC, m.id`,
          ).all<Omit<MerchantSummary, 'revenue'>>(),
          env.ORDERS.prepare(
            `SELECT l.merchant_id, ${CURRENCY} AS currency, SUM(l.qty * l.unit_price_cents) AS minor
               ${SALES}
              WHERE o.payment_status = ? AND o.created_at >= ?
              GROUP BY l.merchant_id, ${CURRENCY}
              ORDER BY ${CURRENCY}`,
          )
            .bind('succeeded', utcDay(29))
            .all<{ merchant_id: string; currency: string; minor: number }>(),
        ])
        const earned = revenue.results ?? []
        return (merchants.results ?? []).map((m) => ({
          ...m,
          revenue: amountsOf(earned.filter((r) => r.merchant_id === m.merchant_id)),
        }))
      },

      async suspend(merchantId: string) {
        await transition(merchantId, 'active', 'suspended')
        return { merchant_id: merchantId, status: 'suspended' as const }
      },

      async restore(merchantId: string) {
        await transition(merchantId, 'suspended', 'active')
        return { merchant_id: merchantId, status: 'active' as const }
      },
    },

    audit: {
      async list({ merchantId, page }) {
        const w = where([merchantId === null ? null : ['a.merchant_id = ?', merchantId]])
        // ponytail: OFFSET paging, which rescans skipped rows and shifts by
        // whatever was written since page one. Keyset on (at, id) if anyone
        // ever pages deep into it.
        const { results } = await env.ORDERS.prepare(
          `SELECT a.id, a.at, a.actor_id, s.email AS actor_email, a.actor_scope,
                  a.merchant_id, m.name AS merchant_name, a.action, a.subject
             FROM audit_log a
             LEFT JOIN staff s ON s.id = a.actor_id
             LEFT JOIN merchants m ON m.id = a.merchant_id${w.sql}
            ORDER BY a.at DESC, a.id DESC
            LIMIT ? OFFSET ?`,
        )
          .bind(...w.args, AUDIT_PAGE + 1, page * AUDIT_PAGE)
          .all<AuditPage['entries'][number]>()
        const rows = results ?? []
        return {
          merchant_id: merchantId,
          page,
          hasMore: rows.length > AUDIT_PAGE,
          entries: rows.slice(0, AUDIT_PAGE),
        }
      },
    },
  }
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
          // display_order after everything already there: the default of 0
          // would tie with the curated first product, and the created_at DESC
          // tiebreak would then put every new listing at the top of the shop.
          `INSERT INTO products (id, merchant_id, sku, title, brand, category, price_minor, currency, status, display_order)
           VALUES (?,?,?,?,?,?,?,?,'draft', (SELECT COALESCE(MAX(display_order), -1) + 1 FROM products))`,
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

    orders: {
      async list(range: OrderRange) {
        // The tenant clause is on the LINE, so an order shared with another
        // merchant appears here, but summed over this merchant's lines only.
        const w = where([
          PAID,
          ['o.created_at >= ?', range.from],
          ["o.created_at < date(?, '+1 day')", range.to],
          tenant(scope, 'l.merchant_id'),
        ])
        // ponytail: capped, not paged. The date range is the pager; a seller
        // with 1000 orders in one range needs a narrower range or real paging.
        const { results } = await env.ORDERS.prepare(
          `SELECT o.id, o.created_at, o.method, o.payment_status, ${CURRENCY} AS currency,
                  SUM(l.qty) AS items, SUM(l.qty * l.unit_price_cents) AS minor
             ${SALES}${w.sql}
            GROUP BY o.id, ${CURRENCY}
            ORDER BY o.created_at DESC, o.id DESC, ${CURRENCY}
            LIMIT 1000`,
        )
          .bind(...w.args)
          .all<Omit<OrderSummary, 'totals'> & Amount>()

        const orders = new Map<string, OrderSummary>()
        for (const { currency, minor, items, ...o } of results ?? []) {
          const seen = orders.get(o.id)
          if (seen) {
            seen.items += items
            seen.totals.push({ currency, minor })
          } else {
            orders.set(o.id, { ...o, items, totals: [{ currency, minor }] })
          }
        }
        return [...orders.values()]
      },

      async get(orderId: string) {
        const w = where([['l.order_id = ?', orderId], tenant(scope, 'l.merchant_id')])
        const [lines, totals] = await Promise.all([
          env.ORDERS.prepare(
            `SELECT l.product_id, l.sku, l.title, l.variant, l.qty, l.unit_price_cents, ${CURRENCY} AS currency
               FROM order_lines l LEFT JOIN products p ON p.id = l.product_id${w.sql}
              ORDER BY l.title, l.variant`,
          )
            .bind(...w.args)
            .all<OrderDetail['lines'][number]>(),
          env.ORDERS.prepare(
            `SELECT ${CURRENCY} AS currency, SUM(l.qty * l.unit_price_cents) AS minor
               FROM order_lines l LEFT JOIN products p ON p.id = l.product_id${w.sql}
              GROUP BY ${CURRENCY} ORDER BY ${CURRENCY}`,
          )
            .bind(...w.args)
            .all<Amount>(),
        ])
        // No line of theirs: not their order. Checked before the header is
        // even read, so another merchant's customer's address is never loaded.
        if (!lines.results?.length) return null

        const header = await env.ORDERS.prepare(
          `SELECT id, created_at, method, payment_status, ship_name, ship_country, ship_line1,
                  ship_line2, ship_city, ship_state, ship_postal
             FROM orders WHERE id = ? AND payment_status = ?`,
        )
          .bind(orderId, 'succeeded')
          .first<Omit<OrderDetail, 'lines' | 'totals'>>()
        if (!header) return null
        return { ...header, lines: lines.results, totals: amountsOf(totals.results ?? []) }
      },
    },

    stats: {
      async overview() {
        // One clock for every boundary, so the windows and the trend agree.
        const now = Date.now()
        const [today, week, month] = [utcDay(0, now), utcDay(6, now), utcDay(29, now)]
        const sales = where([PAID, ['o.created_at >= ?', month], tenant(scope, 'l.merchant_id')])
        const own = where([tenant(scope)])
        const low = where([['status = ?', 'published'], ['stock_count <= ?', LOW_STOCK], tenant(scope)])

        const [daily, windows, counts, top, statuses, lowStock] = await Promise.all([
          env.ORDERS.prepare(
            `SELECT substr(o.created_at, 1, 10) AS day, ${CURRENCY} AS currency,
                    SUM(l.qty * l.unit_price_cents) AS minor
               ${SALES}${sales.sql}
              GROUP BY day, ${CURRENCY} ORDER BY day, ${CURRENCY}`,
          )
            .bind(...sales.args)
            .all<{ day: string } & Amount>(),
          env.ORDERS.prepare(
            `SELECT ${CURRENCY} AS currency,
                    SUM(CASE WHEN o.created_at >= ? THEN l.qty * l.unit_price_cents ELSE 0 END) AS today,
                    SUM(CASE WHEN o.created_at >= ? THEN l.qty * l.unit_price_cents ELSE 0 END) AS week,
                    SUM(l.qty * l.unit_price_cents) AS month
               ${SALES}${sales.sql}
              GROUP BY ${CURRENCY} ORDER BY ${CURRENCY}`,
          )
            .bind(today, week, ...sales.args)
            .all<{ currency: string; today: number; week: number; month: number }>(),
          // Distinct orders: one order with three of this merchant's lines is
          // one order, not three.
          env.ORDERS.prepare(
            `SELECT COUNT(DISTINCT CASE WHEN o.created_at >= ? THEN o.id END) AS today,
                    COUNT(DISTINCT CASE WHEN o.created_at >= ? THEN o.id END) AS week,
                    COUNT(DISTINCT o.id) AS month
               ${SALES}${sales.sql}`,
          )
            .bind(today, week, ...sales.args)
            .first<Overview['orders']>(),
          env.ORDERS.prepare(
            `SELECT product_id, title, currency, minor, qty FROM (
               SELECT l.product_id, MAX(COALESCE(p.title, l.title)) AS title, ${CURRENCY} AS currency,
                      SUM(l.qty * l.unit_price_cents) AS minor, SUM(l.qty) AS qty,
                      ROW_NUMBER() OVER (PARTITION BY ${CURRENCY}
                                         ORDER BY SUM(l.qty * l.unit_price_cents) DESC, l.product_id) AS rank
                 ${SALES}${sales.sql}
                GROUP BY l.product_id, ${CURRENCY})
              WHERE rank <= 5 ORDER BY currency, minor DESC, product_id`,
          )
            .bind(...sales.args)
            .all<Overview['top'][number]>(),
          env.ORDERS.prepare(`SELECT status, COUNT(*) AS n FROM products${own.sql} GROUP BY status`)
            .bind(...own.args)
            .all<{ status: keyof Overview['products']; n: number }>(),
          env.ORDERS.prepare(
            `SELECT id, title, stock_count FROM products${low.sql} ORDER BY stock_count, title LIMIT 50`,
          )
            .bind(...low.args)
            .all<Overview['lowStock'][number]>(),
        ])

        const w = windows.results ?? []
        const products = { draft: 0, published: 0, archived: 0 }
        for (const { status, n } of statuses.results ?? []) products[status] = n
        return {
          revenue: {
            today: w.map((r) => ({ currency: r.currency, minor: r.today })),
            week: w.map((r) => ({ currency: r.currency, minor: r.week })),
            month: w.map((r) => ({ currency: r.currency, minor: r.month })),
          },
          orders: counts ?? { today: 0, week: 0, month: 0 },
          trend: Array.from({ length: 30 }, (_, i) => {
            const day = utcDay(29 - i, now)
            return { day, revenue: amountsOf((daily.results ?? []).filter((r) => r.day === day)) }
          }),
          top: top.results ?? [],
          lowStock: lowStock.results ?? [],
          products,
        }
      },
    },
  }

  const wrap = (group: string, methods: object) => wrapGroup(env, scope, group, methods)

  const audited: Repository = {
    products: wrap('products', raw.products) as Repository['products'],
    orders: wrap('orders', raw.orders) as Repository['orders'],
    stats: wrap('stats', raw.stats) as Repository['stats'],
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
export const platformWide = async (env: TenancyEnv, staffId: string): Promise<PlatformRepository> => {
  const scope: Scope = { kind: 'platform', staffId }
  const only = platformOnly(env)
  return {
    ...build(env, scope),
    merchants: wrapGroup(env, scope, 'merchants', only.merchants) as PlatformRepository['merchants'],
    audit: wrapGroup(env, scope, 'audit', only.audit) as PlatformRepository['audit'],
  }
}

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
