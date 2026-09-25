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
    /**
     * Newest first, at most ORDER_CAP + 1: one past the cap, so the caller can
     * say the list was cut instead of silently showing a partial one.
     */
    list(range: OrderRange): Promise<OrderSummary[]>
    get(id: string): Promise<OrderDetail | null>
  }
  stats: {
    overview(): Promise<Overview>
  }
  /**
   * This merchant's own part of an order: pending → shipped → delivered, or
   * pending → cancelled. Each is the status change and its audit row in one
   * batch. Null when the order holds no line of this merchant's (the route's
   * 404); Conflict for any other transition (409). Merchant scope only: the
   * platform has no part of an order to ship, so it throws there, as
   * products.create does.
   */
  fulfilment: {
    ship(orderId: string, input: { carrier: string; tracking: string }): Promise<Fulfilment | null>
    deliver(orderId: string): Promise<Fulfilment | null>
    /** Also puts the part's units back in stock and refunds whatever of its lines is not yet refunded. */
    cancel(orderId: string): Promise<Fulfilment | null>
  }
  refunds: {
    /**
     * Money back on one line of a paid order, within what was paid for it
     * less every earlier refund. Null when the line is not in scope.
     */
    create(orderId: string, input: NewRefund): Promise<Refund | null>
  }
  finance: {
    /** Per merchant and currency. A merchant sees its own rows; the platform every merchant's. */
    balance(): Promise<Balance[]>
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
    /**
     * active → suspended, and its audit row, in one batch. Throws when the
     * merchant is not active; nothing is written then.
     */
    suspend(id: string): Promise<{ merchant_id: string; status: 'suspended' }>
    /** suspended → active, the same way. Never pending → active: approval is its own flow. */
    restore(id: string): Promise<{ merchant_id: string; status: 'active' }>
    /** The platform's cut, in basis points (0..10000), with its audit row. Null for no such merchant. */
    setCommission(id: string, bps: number): Promise<{ merchant_id: string; commission_bps: number } | null>
  }
  payouts: {
    /**
     * Records a simulated payout. Refused (Conflict) when it is more than the
     * merchant's available balance in that currency — checked by the same
     * statement that inserts it, so two payouts racing cannot both pass.
     * Null for no such merchant.
     */
    create(merchantId: string, input: NewPayout): Promise<Payout | null>
  }
  parts: {
    /**
     * Cancels one merchant's pending part of an order on its behalf — the
     * way out for a suspended merchant's unshipped orders, whose own staff can
     * no longer act. The same state machine, restock and refunds as the
     * merchant's own cancel, audited as the platform's act. Null for no such
     * part.
     */
    cancel(orderId: string, merchantId: string): Promise<Fulfilment | null>
  }
  audit: {
    /**
     * Newest first by insertion order. `before` is the previous page's `next`.
     * Throws when `merchantId` names no merchant.
     */
    list(filter: { merchantId: string | null; before: number | null }): Promise<AuditPage>
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
  /** Whose lines these are: the merchant itself, or on a platform read every merchant in the order. */
  merchant_ids: string[]
  /** The in-scope parts' fulfilment, by merchant id: one entry for a merchant. */
  fulfilment: FulfilmentStatus[]
}

export type FulfilmentStatus = 'pending' | 'shipped' | 'delivered' | 'cancelled'

/** One merchant's part of one order. */
export interface Fulfilment {
  order_id: string
  merchant_id: string
  status: FulfilmentStatus
  carrier: string | null
  tracking: string | null
  shipped_at: string | null
  delivered_at: string | null
  updated_at: string
  /** 1 when checkout took this part's units out of stock; 0 for a part backfilled from before 0013. */
  stock_taken: number
}

export interface NewRefund {
  productId: string
  /** The line's finish; '' when none was offered. Part of the line key. */
  variant: string
  /** Units refunded, 0 for money only. */
  qty: number
  /** Minor units. Defaults to qty × the line's unit price. */
  amountMinor?: number
  reason: string
}

export interface Refund {
  id: string
  order_id: string
  merchant_id: string
  product_id: string
  variant: string
  qty: number
  amount_minor: number
  currency: string
  reason: string
}

/**
 * A merchant's money in one currency, integer minor units throughout.
 *
 *   commission = floor(Σ over lines of (line gross − line refunds) × line.commission_bps / 10000)
 *   available  = gross − refunds − commission − payouts
 *
 * Each line carries the rate it was sold at (order_lines.commission_bps, copied
 * from the merchant at checkout), so changing a merchant's rate prices future
 * sales only. The floor is taken once, on the sum per merchant and currency —
 * not per order or per line. Flooring per order would under-collect up to one
 * minor unit per order and make the figure depend on how sales were split;
 * flooring the total makes the balance a pure function of the ledger, and
 * whatever fraction is dropped stays with the merchant.
 *
 * `available` can be negative — a refund after a payout, most often. That is
 * money the merchant owes the platform, and `owes` says so rather than leaving
 * a minus sign to be noticed.
 */
export interface Balance {
  merchant_id: string
  currency: string
  /** The merchant's rate now: what the next sale will be charged. */
  current_bps: number
  gross: number
  refunds: number
  commission: number
  payouts: number
  available: number
  /** available < 0: the merchant owes the platform that much. */
  owes: boolean
}

export interface NewPayout {
  currency: string
  amountMinor: number
  reference: string
}

export interface Payout {
  id: string
  merchant_id: string
  currency: string
  amount_minor: number
  reference: string
  created_by: string
}

/**
 * A refused change the caller can act on: a transition the state machine does
 * not allow, a refund over the cap, a payout over the balance. Routes answer it
 * with 409 and its message.
 */
export class Conflict extends Error {}

/** A request the repository cannot act on as stated (a refund of nothing, say). Routes answer 400. */
export class Invalid extends Error {}

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
    merchant_id: string
    sku: string
    title: string
    variant: string
    qty: number
    unit_price_cents: number
    currency: string
    refunded_qty: number
    refunded_minor: number
  }[]
  /** Goods sold, before refunds. */
  totals: Amount[]
  /** Whose lines were read, as on OrderSummary. */
  merchant_ids: string[]
  /** The in-scope parts, one per merchant. */
  fulfilment: Fulfilment[]
}

export interface Overview {
  /**
   * Net sales: goods on paid orders less what was refunded on them, by the
   * day the order was placed. Calendar days in UTC: today, the last 7
   * including today, the last 30.
   */
  revenue: { today: Amount[]; week: Amount[]; month: Amount[] }
  /** The same windows before refunds. */
  gross: { today: Amount[]; week: Amount[]; month: Amount[] }
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
  /** Net sales, last 30 days. */
  revenue: Amount[]
}

export interface AuditPage {
  /** The merchant filtered to, so the read of their log is recorded against them. */
  merchant_id: string | null
  /** Pass as `before` for the next, older page; null on the last one. */
  next: number | null
  entries: {
    /** The row's insertion sequence (SQLite rowid): the order the log is read in, and the cursor. */
    seq: number
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
  /**
   * Every merchant's id and name, for the viewer's filter. Carried by this
   * read rather than fetched through merchants.list, which is audited once
   * per merchant: opening the log would otherwise write a row per merchant
   * into the log being opened. Names are the platform's own registry, not a
   * merchant's orders, prices or revenue.
   */
  merchants: { id: string; name: string }[]
}

/** Published and at or under this many units: the overview's low-stock alert. */
export const LOW_STOCK = 5
/** One audit page. */
export const AUDIT_PAGE = 50
/** The most orders one list returns. orders.list fetches one more, to tell. */
export const ORDER_CAP = 1000

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
const READS = new Set([
  'products.list',
  'products.get',
  'orders.list',
  'orders.get',
  'stats.overview',
  'finance.balance',
])

/**
 * Writes that record their own audit row, in the same batch as the change,
 * so the change and its row commit or fail together. The wrapper stays out of
 * them, or each would be recorded twice. A method belongs here only if its
 * body writes the row itself; the test that pins this set says so too.
 */
export const SELF_AUDITED = new Set([
  'merchants.suspend',
  'merchants.restore',
  'merchants.setCommission',
  'fulfilment.ship',
  'fulfilment.deliver',
  'fulfilment.cancel',
  'refunds.create',
  'payouts.create',
  'parts.cancel',
])

/**
 * Whether this call is worth a row from the wrapper.
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
  !SELF_AUDITED.has(dotted) && (scope.kind === 'platform' || !READS.has(dotted))

/**
 * The merchants a platform call's result drew on, one audit row each.
 *
 * A result (or each row of a list) names them as `merchant_id` or
 * `merchant_ids`. A result that names none is recorded once against NULL,
 * which in this log means "not one merchant's": a platform-wide aggregate
 * such as stats.overview, or the unfiltered audit log. An empty list drew on
 * nobody and records nothing.
 */
function drawnOn(result: unknown): (string | null)[] {
  const rows = Array.isArray(result) ? result : [result]
  const named = rows.flatMap((r) => {
    const { merchant_id, merchant_ids } = (r ?? {}) as { merchant_id?: string | null; merchant_ids?: string[] }
    const ids = [...(merchant_ids ?? []), ...(merchant_id ? [merchant_id] : [])]
    return ids.length ? ids : [null]
  })
  return [...new Set(named)]
}

/**
 * Every audit row for one call, in ONE statement, whatever the merchant count.
 *
 * A statement per merchant made a platform list cost N statements. With 41
 * merchants the overview page passed Workers Free's 50 per invocation and
 * failed after some of its rows were already written. One INSERT ... SELECT
 * over a JSON array of [id, merchant] pairs is one statement for 1 or 1000.
 * The ids are minted here, the way every other id in this worker is.
 *
 * Numbered `?1..?5`: a fixed INSERT has no clause that appears or disappears,
 * so there is no numbering to shift under an off-by-one.
 */
async function record(
  env: TenancyEnv,
  scope: Scope,
  dotted: string,
  merchants: (string | null)[],
  subject: string | null,
): Promise<void> {
  if (!merchants.length) return
  await env.ORDERS.prepare(
    `INSERT INTO audit_log (id, actor_id, actor_scope, merchant_id, action, subject)
     SELECT json_extract(value, '$[0]'), ?1, ?2, json_extract(value, '$[1]'), ?3, ?4 FROM json_each(?5)`,
  )
    .bind(scope.staffId, scope.kind, dotted, subject, JSON.stringify(merchants.map((m) => [id('aud'), m])))
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
 * exactly the coverage this wrapper trades away. The writes in SELF_AUDITED
 * pay that price — a merchant's status, an order's fulfilment, and anything
 * that moves money — because those are the writes whose missing row would
 * matter most. `record`'s own failure is still not
 * swallowed: see the catch below.
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
              // One row per merchant drawn on, so each merchant finds the read
              // under their own id — written by one statement, not N.
              const touched: (string | null)[] =
                scope.kind === 'merchant' ? [scope.merchantId] : drawnOn(result)
              try {
                await record(env, scope, dotted, touched, subject)
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
 * frozen unit price, less what was refunded on the line (NET; GROSS is before
 * refunds). Shipping and tax belong to the order, not to any one
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
 * What has been refunded on line `l` so far. Correlated rather than joined,
 * so each is a seek on refunds_line_idx instead of grouping every refund.
 */
const REFUNDED_QTY = `(SELECT COALESCE(SUM(r.qty), 0) FROM refunds r
   WHERE r.order_id = l.order_id AND r.product_id = l.product_id AND r.variant = l.variant)`
const REFUNDED_MINOR = `(SELECT COALESCE(SUM(r.amount_minor), 0) FROM refunds r
   WHERE r.order_id = l.order_id AND r.product_id = l.product_id AND r.variant = l.variant)`
/** A line's sales before refunds, and after. Every "revenue" figure is NET. */
const GROSS = 'l.qty * l.unit_price_cents'
const NET = `(${GROSS} - ${REFUNDED_MINOR})`

/**
 * Every in-scope merchant's balance per currency, as one SELECT; see Balance
 * for the arithmetic. Shared by finance.balance and payouts.create, so the
 * figure a payout is checked against is the figure the page shows.
 *
 * Commission is SQLite integer division of non-negative integers, which is the
 * floor. Refunds and payouts take their currency the way lines do: refunds
 * from the product row, payouts as recorded (they were checked against it).
 */
function balances(scope: Scope): { sql: string; args: unknown[] } {
  const sold = where([PAID, tenant(scope, 'l.merchant_id')])
  const back = where([tenant(scope, 'r.merchant_id')])
  const paid = where([tenant(scope)])
  return {
    sql: `SELECT g.merchant_id, g.currency, m.commission_bps AS current_bps, g.minor AS gross,
                 COALESCE(rf.minor, 0) AS refunds, g.commission,
                 COALESCE(po.minor, 0) AS payouts
            FROM (SELECT l.merchant_id, ${CURRENCY} AS currency, SUM(${GROSS}) AS minor,
                         -- Each line at the rate it was sold at, floored once on the sum.
                         SUM(${NET} * l.commission_bps) / 10000 AS commission
                    ${SALES}${sold.sql}
                   GROUP BY l.merchant_id, ${CURRENCY}) g
            JOIN merchants m ON m.id = g.merchant_id
            LEFT JOIN (SELECT r.merchant_id, ${CURRENCY} AS currency, SUM(r.amount_minor) AS minor
                         FROM refunds r LEFT JOIN products p ON p.id = r.product_id${back.sql}
                        GROUP BY r.merchant_id, ${CURRENCY}) rf
              ON rf.merchant_id = g.merchant_id AND rf.currency = g.currency
            LEFT JOIN (SELECT merchant_id, currency, SUM(amount_minor) AS minor FROM payouts${paid.sql}
                        GROUP BY merchant_id, currency) po
              ON po.merchant_id = g.merchant_id AND po.currency = g.currency`,
    args: [...sold.args, ...back.args, ...paid.args],
  }
}

/**
 * The refund cap, as the last statement of any batch that inserts a refund.
 *
 * If any line of the order now has more refunded than was paid for it (units
 * or money), this inserts a row with qty -1, the qty CHECK fails, and D1 rolls
 * the whole batch back — 0009's rollback guard. The checks before a batch give
 * the refusal its message; this is the check that holds when two refunds race,
 * because it reads the ledger inside the transaction that writes it.
 */
const refundCapGuard = (env: TenancyEnv, orderId: string) =>
  env.ORDERS.prepare(
    `INSERT INTO refunds (id, order_id, merchant_id, product_id, variant, qty, amount_minor,
                          reason, actor_id, actor_scope)
     SELECT 'rfd_cap_guard', l.order_id, l.merchant_id, l.product_id, l.variant, -1, 1,
            'refund cap guard', 'guard', 'platform'
       FROM order_lines l
      WHERE l.order_id = ? AND (${REFUNDED_QTY} > l.qty OR ${REFUNDED_MINOR} > ${GROSS})`,
  ).bind(orderId)

/** What the guard's refusal looks like once D1 reports it. */
const overCap = (err: unknown) => /CHECK constraint failed/.test(String(err)) && /qty >= 0/.test(String(err))

/** The fulfilment state machine: each action's one legal `from` and its `to`. Anything else is a 409. */
const MOVES = {
  ship: ['pending', 'shipped'],
  deliver: ['shipped', 'delivered'],
  cancel: ['pending', 'cancelled'],
} as const

type MoveRest = [
  set?: string,
  setArgs?: unknown[],
  detail?: object | null,
  after?: (auditId: string, merchantId: string) => D1PreparedStatement[],
]

/** One merchant's part of a paid order, or null. */
const partOf = (env: TenancyEnv, orderId: string, merchantId: string) =>
  env.ORDERS.prepare(
    `SELECT f.* FROM order_fulfilments f JOIN orders o ON o.id = f.order_id
      WHERE f.order_id = ? AND f.merchant_id = ? AND o.payment_status = ?`,
  )
    .bind(orderId, merchantId, 'succeeded')
    .first<Fulfilment>()

/**
 * One step of the fulfilment state machine on `merchantId`'s part: the status
 * change, its audit row (recorded as `action`, by `actor`), and whatever
 * `after` adds, in one batch.
 *
 * The UPDATE matches only the `from` status, and the audit INSERT only if the
 * UPDATE changed a row, so a transition that lost a race writes nothing at
 * all. The status is also checked first, which is where a refusal gets a
 * message worth showing. Whose part it is comes from the caller: the scope's
 * own merchant for a merchant, a named one for the platform.
 */
async function movePart(
  env: TenancyEnv,
  actor: Scope,
  orderId: string,
  merchantId: string,
  step: keyof typeof MOVES,
  action: string,
  set = '',
  setArgs: unknown[] = [],
  detail: object | null = null,
  after: (auditId: string, merchantId: string) => D1PreparedStatement[] = () => [],
): Promise<Fulfilment | null> {
  const row = await partOf(env, orderId, merchantId)
  if (!row) return null
  const [from, to] = MOVES[step]
  if (row.status !== from) {
    throw new Conflict(`Only a ${from} order can be marked ${to}; this one is ${row.status}.`)
  }
  const auditId = id('aud')
  const [update] = await env.ORDERS.batch([
    env.ORDERS.prepare(
      `UPDATE order_fulfilments SET status = ?${set}, updated_at = datetime('now')
        WHERE order_id = ? AND merchant_id = ? AND status = ?`,
    ).bind(to, ...setArgs, orderId, merchantId, from),
    env.ORDERS.prepare(
      `INSERT INTO audit_log (id, actor_id, actor_scope, merchant_id, action, subject, detail)
       SELECT ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
    ).bind(auditId, actor.staffId, actor.kind, merchantId, action, orderId, detail && JSON.stringify(detail)),
    ...after(auditId, merchantId),
  ])
  if (update.meta.changes !== 1) throw new Conflict('This order changed in the meantime. Reload and try again.')
  return partOf(env, orderId, merchantId)
}

/**
 * What cancelling a part does besides its status: units back on the shelf and
 * the lines refunded. Both conditional on THIS call's audit row, which exists
 * only if the status change matched — keyed on the row rather than on the
 * status, because a second cancel finds the part already cancelled and must
 * restock and refund nothing.
 *
 * Restocked only where checkout took the stock (stock_taken = 1). A part
 * backfilled from before 0013 never took any, and putting its units back would
 * conjure stock. Where it did, every unit goes back: a pending part never left
 * the warehouse, whatever was refunded on it before. Line refunds alone never
 * restock: a refund is money, not a return.
 */
const cancelEffects =
  (env: TenancyEnv, actor: Scope, orderId: string) =>
  (auditId: string, merchantId: string): D1PreparedStatement[] => [
    env.ORDERS.prepare(
      `UPDATE products
          SET stock_count = stock_count + (SELECT SUM(l.qty) FROM order_lines l
                                            WHERE l.order_id = ? AND l.merchant_id = ? AND l.product_id = products.id),
              updated_at = datetime('now')
        WHERE id IN (SELECT l.product_id FROM order_lines l WHERE l.order_id = ? AND l.merchant_id = ?)
          AND EXISTS (SELECT 1 FROM order_fulfilments
                       WHERE order_id = ? AND merchant_id = ? AND stock_taken = 1)
          AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)`,
    ).bind(orderId, merchantId, orderId, merchantId, orderId, merchantId, auditId),
    // Whatever of each line is not refunded yet, in full. The ids are minted by
    // SQLite, one per line, because the lines are only known inside this
    // statement; they are opaque either way.
    env.ORDERS.prepare(
      `INSERT INTO refunds (id, order_id, merchant_id, product_id, variant, qty, amount_minor,
                            reason, actor_id, actor_scope)
       SELECT 'rfd_' || lower(hex(randomblob(10))), l.order_id, l.merchant_id, l.product_id, l.variant,
              l.qty - ${REFUNDED_QTY}, ${NET}, 'Order cancelled', ?, ?
         FROM order_lines l
        WHERE l.order_id = ? AND l.merchant_id = ? AND ${NET} > 0
          AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)`,
    ).bind(actor.staffId, actor.kind, orderId, merchantId, auditId),
    // Cannot fire (the remainder is computed in this same transaction), and
    // there anyway, so no batch that writes a refund goes unguarded.
    refundCapGuard(env, orderId),
  ]

/** Two decimals, for a refusal message. Display only; nothing is computed from it. */
const shown = (minor: number, currency: string) => `${(minor / 100).toFixed(2)} ${currency}`

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
function platformOnly(env: TenancyEnv, staffId: string): Omit<PlatformRepository, keyof Repository> {
  /*
   * The status change and its audit row in one batch, the way approveMerchant
   * does it: D1 runs a batch as one transaction, so either both land or
   * neither does. The INSERT is conditional on changes() = 1, so a refused
   * transition (pending, already there, no such merchant) writes no row.
   */
  const transition = async (merchantId: string, from: string, to: string, action: string) => {
    const [update, audit] = await env.ORDERS.batch([
      env.ORDERS.prepare(`UPDATE merchants SET status = ?1 WHERE id = ?2 AND status = ?3`).bind(to, merchantId, from),
      env.ORDERS.prepare(
        `INSERT INTO audit_log (id, actor_id, actor_scope, merchant_id, action, subject)
         SELECT ?1, ?2, 'platform', ?3, ?4, ?3 WHERE changes() = 1`,
      ).bind(id('aud'), staffId, merchantId, action),
    ])
    // Relies on a batch running in order on one connection, as approveMerchant
    // does; this makes the day that stops holding visible instead of silent.
    if (audit.meta.changes !== update.meta.changes) {
      console.error('merchant status: audit row did not match the update', { merchantId, action })
    }
    if (update.meta.changes !== 1) throw new Error(`merchant ${merchantId} is not ${from}`)
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
            `SELECT l.merchant_id, ${CURRENCY} AS currency, SUM(${NET}) AS minor
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
        await transition(merchantId, 'active', 'suspended', 'merchants.suspend')
        return { merchant_id: merchantId, status: 'suspended' as const }
      },

      async restore(merchantId: string) {
        await transition(merchantId, 'suspended', 'active', 'merchants.restore')
        return { merchant_id: merchantId, status: 'active' as const }
      },

      async setCommission(merchantId: string, bps: number) {
        if (!Number.isSafeInteger(bps) || bps < 0 || bps > 10_000) {
          throw new RangeError(`commission_bps is a whole number from 0 to 10000, not ${String(bps)}`)
        }
        // The audit row first, so it can read the rate being replaced. Both
        // select on the merchant existing, so for no such merchant neither
        // writes; and they are one batch, so neither lands without the other.
        const [, update] = await env.ORDERS.batch([
          env.ORDERS.prepare(
            `INSERT INTO audit_log (id, actor_id, actor_scope, merchant_id, action, subject, detail)
             SELECT ?, ?, 'platform', id, 'merchants.setCommission', id,
                    json_object('from', commission_bps, 'to', CAST(? AS INTEGER))
               FROM merchants WHERE id = ?`,
          ).bind(id('aud'), staffId, bps, merchantId),
          env.ORDERS.prepare(`UPDATE merchants SET commission_bps = ? WHERE id = ?`).bind(bps, merchantId),
        ])
        return update.meta.changes === 1 ? { merchant_id: merchantId, commission_bps: bps } : null
      },
    },

    payouts: {
      async create(merchantId: string, input: NewPayout) {
        assertIntegerMinor(input.amountMinor, 'amountMinor')
        if (input.amountMinor <= 0) throw new Invalid('A payout is more than nothing.')
        // XXX is how a line whose product row is gone reads: no currency anyone can be paid in.
        if (input.currency === 'XXX') throw new Invalid('XXX is not a currency a payout can be made in.')
        // The balance of this one merchant: the same SELECT the page reads,
        // with the merchant's own tenant clause.
        const b = balances({ kind: 'merchant', merchantId, staffId })
        const payoutId = id('pay')
        const [insert] = await env.ORDERS.batch([
          env.ORDERS.prepare(
            `INSERT INTO payouts (id, merchant_id, currency, amount_minor, reference, created_by)
             SELECT ?, b.merchant_id, b.currency, ?, ?, ?
               FROM (${b.sql}) b
              WHERE b.currency = ? AND b.gross - b.refunds - b.commission - b.payouts >= ?`,
          ).bind(payoutId, input.amountMinor, input.reference, staffId, ...b.args, input.currency, input.amountMinor),
          env.ORDERS.prepare(
            `INSERT INTO audit_log (id, actor_id, actor_scope, merchant_id, action, subject, detail)
             SELECT ?, ?, 'platform', ?, 'payouts.create', ?, ? WHERE changes() = 1`,
          ).bind(
            id('aud'),
            staffId,
            merchantId,
            payoutId,
            JSON.stringify({ currency: input.currency, amount_minor: input.amountMinor, reference: input.reference }),
          ),
        ])
        if (insert.meta.changes !== 1) {
          const exists = await env.ORDERS.prepare(`SELECT 1 AS one FROM merchants WHERE id = ?`).bind(merchantId).first()
          if (!exists) return null
          throw new Conflict(`That is more than this merchant's available ${input.currency} balance.`)
        }
        return {
          id: payoutId,
          merchant_id: merchantId,
          currency: input.currency,
          amount_minor: input.amountMinor,
          reference: input.reference,
          created_by: staffId,
        }
      },
    },

    parts: {
      cancel(orderId: string, merchantId: string) {
        const actor: Scope = { kind: 'platform', staffId }
        return movePart(env, actor, orderId, merchantId, 'cancel', 'parts.cancel', '', [], null, cancelEffects(env, actor, orderId))
      },
    },

    audit: {
      async list({ merchantId, before }) {
        /*
         * Keyset on rowid, not OFFSET. The log is append-only (no DELETE, by
         * trigger), so rowid is its insertion order: unique, increasing, and
         * the true order among rows written in the same second, where `at`
         * ties and the random `id` would shuffle them. Reading a page writes
         * its own audit.list row; under OFFSET that shifted every later page
         * by one and showed an entry twice. `rowid < before` cannot shift.
         * Unfiltered, this seeks on the table's own key; filtered, on
         * audit_merchant_seq_idx (migration 0012).
         */
        const w = where([
          merchantId === null ? null : ['a.merchant_id = ?', merchantId],
          before === null ? null : ['a.rowid < ?', before],
        ])
        const [merchants, page] = await Promise.all([
          env.ORDERS.prepare(`SELECT id, name FROM merchants ORDER BY name, id`).all<{ id: string; name: string }>(),
          env.ORDERS.prepare(
            `SELECT a.rowid AS seq, a.id, a.at, a.actor_id, s.email AS actor_email, a.actor_scope,
                    a.merchant_id, m.name AS merchant_name, a.action, a.subject
               FROM audit_log a
               LEFT JOIN staff s ON s.id = a.actor_id
               LEFT JOIN merchants m ON m.id = a.merchant_id${w.sql}
              ORDER BY a.rowid DESC
              LIMIT ?`,
          )
            .bind(...w.args, AUDIT_PAGE + 1)
            .all<AuditPage['entries'][number]>(),
        ])
        const names = merchants.results ?? []
        // Checked, not left to the audit row's foreign key: that failed as a
        // 500 after the read. Thrown so the wrapper records nothing — no log
        // was read.
        if (merchantId !== null && !names.some((m) => m.id === merchantId)) {
          throw new Error(`merchant ${merchantId} does not exist`)
        }
        const rows = page.results ?? []
        const entries = rows.slice(0, AUDIT_PAGE)
        return {
          merchant_id: merchantId,
          next: rows.length > AUDIT_PAGE ? entries[entries.length - 1].seq : null,
          entries,
          merchants: names,
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

  /**
   * The scope's own merchant, for the fulfilment steps: the merchant id in
   * every WHERE is the scope's, so another merchant's order reads as no order.
   */
  const own = () => {
    if (scope.kind !== 'merchant') {
      throw new Error('only a merchant ships, delivers or cancels its own part of an order')
    }
    return scope.merchantId
  }
  const move = (orderId: string, action: keyof typeof MOVES, ...rest: MoveRest) =>
    movePart(env, scope, orderId, own(), action, `fulfilment.${action}`, ...rest)

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
        const picked = where([
          PAID,
          ['o.created_at >= ?', range.from],
          ["o.created_at < date(?, '+1 day')", range.to],
          tenant(scope, 'l.merchant_id'),
        ])
        const mine = where([tenant(scope, 'l.merchant_id')])
        // The fulfilment of the in-scope parts, in a subquery of its own, so
        // its tenant clause (when there is one) binds between the two above.
        const parts = tenant(scope, 'f.merchant_id')
        // The cap counts ORDERS, in the CTE. A LIMIT on the grouped rows below
        // would count an order once per currency, and cut an order in half.
        // ponytail: capped, not paged — the date range is the pager. Real
        // paging when a seller routinely has more than ORDER_CAP in a range.
        const { results } = await env.ORDERS.prepare(
          `WITH picked AS (
             SELECT o.id FROM orders o JOIN order_lines l ON l.order_id = o.id${picked.sql}
              GROUP BY o.id
              ORDER BY o.created_at DESC, o.id DESC
              LIMIT ?
           )
           SELECT o.id, o.created_at, o.method, o.payment_status, ${CURRENCY} AS currency,
                  SUM(l.qty) AS items, SUM(${GROSS}) AS minor,
                  json_group_array(DISTINCT l.merchant_id) AS merchant_ids,
                  (SELECT json_group_array(status) FROM (
                     SELECT f.status FROM order_fulfilments f
                      WHERE f.order_id = o.id${parts ? ` AND ${parts[0]}` : ''}
                      ORDER BY f.merchant_id)) AS fulfilment
             FROM picked
             JOIN orders o ON o.id = picked.id
             JOIN order_lines l ON l.order_id = o.id
             LEFT JOIN products p ON p.id = l.product_id${mine.sql}
            GROUP BY o.id, ${CURRENCY}
            ORDER BY o.created_at DESC, o.id DESC, ${CURRENCY}`,
        )
          .bind(...picked.args, ORDER_CAP + 1, ...(parts ? [parts[1]] : []), ...mine.args)
          .all<
            Omit<OrderSummary, 'totals' | 'merchant_ids' | 'fulfilment'> &
              Amount & { merchant_ids: string; fulfilment: string }
          >()

        const orders = new Map<string, OrderSummary>()
        for (const { currency, minor, items, merchant_ids, fulfilment, ...o } of results ?? []) {
          const ids = JSON.parse(merchant_ids) as string[]
          const seen = orders.get(o.id)
          if (seen) {
            seen.items += items
            seen.totals.push({ currency, minor })
            seen.merchant_ids = [...new Set([...seen.merchant_ids, ...ids])]
          } else {
            orders.set(o.id, {
              ...o,
              items,
              totals: [{ currency, minor }],
              merchant_ids: ids,
              fulfilment: JSON.parse(fulfilment) as FulfilmentStatus[],
            })
          }
        }
        return [...orders.values()]
      },

      async get(orderId: string) {
        const w = where([['l.order_id = ?', orderId], tenant(scope, 'l.merchant_id')])
        const f = where([['order_id = ?', orderId], tenant(scope)])
        const [lines, totals, parts] = await Promise.all([
          env.ORDERS.prepare(
            `SELECT l.product_id, l.merchant_id, l.sku, l.title, l.variant, l.qty, l.unit_price_cents,
                    ${CURRENCY} AS currency, ${REFUNDED_QTY} AS refunded_qty, ${REFUNDED_MINOR} AS refunded_minor
               FROM order_lines l LEFT JOIN products p ON p.id = l.product_id${w.sql}
              ORDER BY l.title, l.variant`,
          )
            .bind(...w.args)
            .all<OrderDetail['lines'][number]>(),
          env.ORDERS.prepare(
            `SELECT ${CURRENCY} AS currency, SUM(${GROSS}) AS minor
               FROM order_lines l LEFT JOIN products p ON p.id = l.product_id${w.sql}
              GROUP BY ${CURRENCY} ORDER BY ${CURRENCY}`,
          )
            .bind(...w.args)
            .all<Amount>(),
          env.ORDERS.prepare(`SELECT * FROM order_fulfilments${f.sql} ORDER BY merchant_id`)
            .bind(...f.args)
            .all<Fulfilment>(),
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
          .first<Omit<OrderDetail, 'lines' | 'totals' | 'merchant_ids' | 'fulfilment'>>()
        if (!header) return null
        return {
          ...header,
          lines: lines.results,
          totals: amountsOf(totals.results ?? []),
          merchant_ids: [...new Set(lines.results.map((l) => l.merchant_id))],
          fulfilment: parts.results ?? [],
        }
      },
    },

    fulfilment: {
      ship: (orderId: string, { carrier, tracking }: { carrier: string; tracking: string }) =>
        move(orderId, 'ship', ', carrier = ?, tracking = ?, shipped_at = datetime(\'now\')', [carrier, tracking], {
          carrier,
          tracking,
        }),
      deliver: (orderId: string) => move(orderId, 'deliver', ", delivered_at = datetime('now')"),
      cancel: (orderId: string) => move(orderId, 'cancel', '', [], null, cancelEffects(env, scope, orderId)),
    },

    refunds: {
      async create(orderId: string, input: NewRefund) {
        assertIntegerMinor(input.qty, 'qty')
        if (input.amountMinor !== undefined) assertIntegerMinor(input.amountMinor, 'amountMinor')
        const w = where([
          ['l.order_id = ?', orderId],
          ['l.product_id = ?', input.productId],
          ['l.variant = ?', input.variant],
          PAID,
          tenant(scope, 'l.merchant_id'),
        ])
        const line = await env.ORDERS.prepare(
          `SELECT l.merchant_id, l.qty, ${GROSS} AS paid, l.unit_price_cents, ${CURRENCY} AS currency,
                  ${REFUNDED_QTY} AS refunded_qty, ${REFUNDED_MINOR} AS refunded_minor
             ${SALES}${w.sql}`,
        )
          .bind(...w.args)
          .first<{
            merchant_id: string
            qty: number
            paid: number
            unit_price_cents: number
            currency: string
            refunded_qty: number
            refunded_minor: number
          }>()
        // Not a line of this scope's: the same answer as no such line.
        if (!line) return null

        const amount = input.amountMinor ?? input.qty * line.unit_price_cents
        // A unit of a free line refunds nothing: say so as a bad request, not a crash.
        if (input.qty < 0 || amount <= 0) throw new Invalid('A refund is for some money: this one comes to nothing. State an amount.')
        const [qtyLeft, minorLeft] = [line.qty - line.refunded_qty, line.paid - line.refunded_minor]
        if (input.qty > qtyLeft) {
          throw new Conflict(`Only ${qtyLeft} of ${line.qty} units on this line are left to refund.`)
        }
        if (amount > minorLeft) {
          throw new Conflict(`Only ${shown(minorLeft, line.currency)} is left to refund on this line.`)
        }

        const refundId = id('rfd')
        try {
          await env.ORDERS.batch([
            env.ORDERS.prepare(
              `INSERT INTO refunds (id, order_id, merchant_id, product_id, variant, qty, amount_minor,
                                    reason, actor_id, actor_scope)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).bind(
              refundId,
              orderId,
              line.merchant_id,
              input.productId,
              input.variant,
              input.qty,
              amount,
              input.reason,
              scope.staffId,
              scope.kind,
            ),
            env.ORDERS.prepare(
              `INSERT INTO audit_log (id, actor_id, actor_scope, merchant_id, action, subject, detail)
               VALUES (?, ?, ?, ?, 'refunds.create', ?, ?)`,
            ).bind(
              id('aud'),
              scope.staffId,
              scope.kind,
              line.merchant_id,
              orderId,
              JSON.stringify({ refund_id: refundId, product_id: input.productId, variant: input.variant, qty: input.qty, amount_minor: amount, currency: line.currency }),
            ),
            refundCapGuard(env, orderId),
          ])
        } catch (err) {
          // The checks above read a moment ago; the guard reads now.
          if (overCap(err)) {
            throw new Conflict('Another refund landed on this line in the meantime. Reload and try again.')
          }
          throw err
        }
        return {
          id: refundId,
          order_id: orderId,
          merchant_id: line.merchant_id,
          product_id: input.productId,
          variant: input.variant,
          qty: input.qty,
          amount_minor: amount,
          currency: line.currency,
          reason: input.reason,
        }
      },
    },

    finance: {
      async balance() {
        const b = balances(scope)
        const { results } = await env.ORDERS.prepare(`${b.sql} ORDER BY g.merchant_id, g.currency`)
          .bind(...b.args)
          .all<Omit<Balance, 'available' | 'owes'>>()
        return (results ?? []).map((r) => {
          const available = r.gross - r.refunds - r.commission - r.payouts
          return { ...r, available, owes: available < 0 }
        })
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
                    SUM(${NET}) AS minor
               ${SALES}${sales.sql}
              GROUP BY day, ${CURRENCY} ORDER BY day, ${CURRENCY}`,
          )
            .bind(...sales.args)
            .all<{ day: string } & Amount>(),
          // Net and gross from one pass: the net is the gross less its refunds.
          env.ORDERS.prepare(
            `SELECT currency,
                    SUM(CASE WHEN at >= ? THEN net ELSE 0 END) AS today,
                    SUM(CASE WHEN at >= ? THEN net ELSE 0 END) AS week,
                    SUM(net) AS month,
                    SUM(CASE WHEN at >= ? THEN gross ELSE 0 END) AS gross_today,
                    SUM(CASE WHEN at >= ? THEN gross ELSE 0 END) AS gross_week,
                    SUM(gross) AS gross_month
               FROM (SELECT o.created_at AS at, ${CURRENCY} AS currency, ${GROSS} AS gross, ${NET} AS net
                       ${SALES}${sales.sql})
              GROUP BY currency ORDER BY currency`,
          )
            .bind(today, week, today, week, ...sales.args)
            .all<{
              currency: string
              today: number
              week: number
              month: number
              gross_today: number
              gross_week: number
              gross_month: number
            }>(),
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
                      SUM(${NET}) AS minor, SUM(l.qty) AS qty,
                      ROW_NUMBER() OVER (PARTITION BY ${CURRENCY}
                                         ORDER BY SUM(${NET}) DESC, l.product_id) AS rank
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
          gross: {
            today: w.map((r) => ({ currency: r.currency, minor: r.gross_today })),
            week: w.map((r) => ({ currency: r.currency, minor: r.gross_week })),
            month: w.map((r) => ({ currency: r.currency, minor: r.gross_month })),
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
    fulfilment: wrap('fulfilment', raw.fulfilment) as Repository['fulfilment'],
    refunds: wrap('refunds', raw.refunds) as Repository['refunds'],
    finance: wrap('finance', raw.finance) as Repository['finance'],
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
  const only = platformOnly(env, staffId)
  return {
    ...build(env, scope),
    merchants: wrapGroup(env, scope, 'merchants', only.merchants) as PlatformRepository['merchants'],
    audit: wrapGroup(env, scope, 'audit', only.audit) as PlatformRepository['audit'],
    payouts: wrapGroup(env, scope, 'payouts', only.payouts) as PlatformRepository['payouts'],
    parts: wrapGroup(env, scope, 'parts', only.parts) as PlatformRepository['parts'],
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
