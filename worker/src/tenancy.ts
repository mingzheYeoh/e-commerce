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
import { authorOf } from './text'

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
    /** Every product with its stock and the units sold on it in the last 30 days. */
    inventory(): Promise<InventoryRow[]>
  }
  /**
   * Orders that hold at least one line in scope, and only those lines. A
   * merchant's view of a shared order is its own lines and their sum — never
   * the order's total, which includes other merchants' goods.
   */
  orders: {
    /**
     * Newest first, at most `limit` (ORDER_CAP by default) + 1: one past, so
     * the caller can tell there is another page, or say the list was cut.
     */
    list(filter: OrderFilter): Promise<OrderSummary[]>
    get(id: string): Promise<OrderDetail | null>
  }
  stats: {
    overview(): Promise<Overview>
    /** What needs doing now: parts to ship, live products running low or out. */
    queue(): Promise<Queue>
    /** Sales in a range and the one before it, by currency, day or week, category and product. */
    sales(range: OrderRange): Promise<SalesReport>
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
    /** Sales, refunds and payouts dated in the range, each with the balance after it; see Ledger. */
    ledger(range: OrderRange): Promise<Ledger>
    /** Every payout, newest first. */
    payouts(): Promise<(Payout & { created_at: string })[]>
  }
  /**
   * Shoppers' reviews of the scope's products, newest first, hidden ones
   * included and marked. Read-only: a merchant cannot edit or hide a review
   * of its own product. Never given to the AI (see rag.ts, tools.ts).
   */
  reviews: {
    list(filter: { limit?: number }): Promise<ReviewRow[]>
  }
  /**
   * Return requests on the scope's parts. The platform reads them; deciding
   * is the merchant's own act, so approve and reject throw in platform scope,
   * as fulfilment does.
   */
  returns: {
    /** Newest first, at most RETURN_CAP. */
    list(filter: { status?: ReturnStatus }): Promise<ReturnSummary[]>
    get(id: string): Promise<ReturnDetail | null>
    /**
     * Refunds `amountMinor` (at most the part's refundable remainder) through
     * the refund path, spread over the part's lines in order, and marks the
     * request approved: the refunds, their audit rows, the decision and its
     * audit row in one batch, ending in the refund cap guard. Null when the
     * request is not in scope; Conflict when it is decided or over the cap.
     */
    approve(id: string, input: { amountMinor: number; note: string }): Promise<ReturnDetail | null>
    /** Marks the request rejected with a note the shopper will read. Invalid without one. */
    reject(id: string, input: { note: string }): Promise<ReturnDetail | null>
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
     * Every merchant's id, name and status, for a filter or a label. The
     * platform's own registry, like the names AuditPage carries: no orders,
     * prices or money, so it is recorded once, not once per merchant.
     */
    names(): Promise<{ id: string; name: string; status: string }[]>
    /** One merchant's profile, staff, catalogue, fulfilment health and balance. Null for no such merchant. */
    get(id: string): Promise<MerchantDetail | null>
    /** stats.sales for one merchant, read by the platform. Null for no such merchant. */
    sales(id: string, range: OrderRange): Promise<(SalesReport & { merchant_id: string }) | null>
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
  /** Money in and out across the platform: what shoppers were charged, refunds, payouts. */
  payments: {
    /** Newest first, at most `limit` + 1, like orders.list; totals cover the whole filter. */
    list(filter: PaymentFilter): Promise<PaymentPage>
  }
  analytics: {
    /** What stats.sales does not carry: order-level charges, a merchant leaderboard, new customers. */
    report(range: OrderRange): Promise<PlatformReport>
    /** What needs the platform's attention now, for the overview's cards. */
    attention(): Promise<Attention>
  }
  /**
   * Shopper accounts. Personal data: explicit columns only, never a password
   * hash, salt, TOTP secret, token or recovery code. Every read is audited
   * (against no merchant: a shopper is the platform's relationship).
   */
  customers: {
    /** Newest sign-up first, at most `limit` + 1, and the guest checkouts as one aggregate. */
    list(filter: CustomerFilter): Promise<CustomerPage>
    /** One account and its paid orders, newest first. Null for no such account. */
    get(id: string): Promise<CustomerDetail | null>
  }
  /**
   * Taking a review out of the product page and its average, and putting it
   * back. Audited by the wrapper against the review's merchant. Null for no
   * such review.
   */
  moderation: {
    hide(reviewId: string): Promise<{ id: string; merchant_id: string; hidden: boolean } | null>
    unhide(reviewId: string): Promise<{ id: string; merchant_id: string; hidden: boolean } | null>
  }
}

export type PaymentKind = 'charge' | 'refund' | 'payout'

/** The payments ledger's filters. The range is required: the route defaults it to 30 days. */
export interface PaymentFilter extends OrderRange {
  kind?: PaymentKind
  merchantId?: string
  currency?: string
  /** Keyset: only entries strictly before this one, in list order. */
  before?: { at: string; rank: number; id: string }
  limit?: number
}

export interface PaymentEntry {
  at: string
  kind: PaymentKind
  /** Sale before refund before payout within one second; with `id`, the list's total order and its cursor. */
  rank: number
  /** The order id (charge), refund id or payout id. */
  id: string
  /** The order id (charge, refund) or the payout's reference. */
  ref: string
  /** A charge's every merchant; a refund's or payout's one. */
  merchant_ids: string[]
  /** A charge's is the order's (see ORDER_CURRENCY); a refund's its line's; a payout's as recorded. */
  currency: string
  /** Signed as it moves the platform's cash: a charge in, a refund or payout out. */
  amount: number
  /** A charge's parts; null on a refund or payout. */
  goods: number | null
  shipping: number | null
  tax: number | null
}

export interface PaymentPage {
  /** Every merchant an entry on this page names, so each finds the read in its own log. */
  merchant_ids: string[]
  entries: PaymentEntry[]
  /** The whole filter, per currency, ignoring the cursor and the limit. */
  totals: {
    currency: string
    charges: number
    charged: number
    goods: number
    shipping: number
    tax: number
    refunds: number
    refunded: number
    payouts: number
    paid_out: number
  }[]
}

/**
 * The platform report's own figures, beside stats.sales in platform scope.
 * Order-level money (shipping, tax, the total charged) is per order in the
 * order's currency: see ORDER_CURRENCY.
 */
export interface PlatformReport extends OrderRange {
  previous: OrderRange
  charges: { period: 'now' | 'before'; currency: string; orders: number; goods: number; shipping: number; tax: number; total: number }[]
  /** Per merchant and currency, the range only, best net first within each currency. */
  merchants: {
    merchant_id: string
    name: string
    currency: string
    gross: number
    refunds: number
    net: number
    commission: number
    orders: number
    units: number
  }[]
  /** Per merchant, the parts of orders placed in the range. */
  health: { merchant_id: string; parts: number; cancelled: number; shipped: number; avg_ship_seconds: number | null }[]
  /** Accounts created in the range, by week counted from `from`. */
  signups: { start: string; count: number }[]
  /** Paid orders in the range, placed signed in or as a guest. */
  buyers: { accounts: number; guests: number }
  /** Every merchant the leaderboard names. */
  merchant_ids: string[]
}

export interface Attention {
  pending_applications: number
  /** Parts of paid orders still pending. */
  to_ship: number
  /** Of those, placed before the UTC day OVERDUE_DAYS ago began. */
  overdue: number
  /** Balances below zero, the deepest 20: the merchant owes the platform. */
  owing: { merchant_id: string; name: string; currency: string; available: number }[]
  /** How many merchants owe, however many `owing` lists. */
  owing_merchants: number
  /** Merchants with a published product at LOW_STOCK units or fewer. */
  low_stock: { merchant_id: string; name: string; products: number }[]
  merchant_ids: string[]
}

export interface MerchantDetail {
  merchant_id: string
  name: string
  slug: string
  status: string
  created_at: string
  settlement_currency: string
  commission_bps: number
  /** No password, salt or TOTP secret: whether a second factor is enrolled, and that is all. */
  staff: { id: string; email: string; role: string; totp_enrolled: boolean; created_at: string }[]
  products: { draft: number; published: number; archived: number; low_stock: number; out_of_stock: number }
  /** Published at LOW_STOCK or fewer, lowest first, at most 20. */
  low: { id: string; title: string; stock_count: number }[]
  /** Parts of paid orders, all time. */
  health: {
    to_ship: number
    overdue: number
    parts: number
    shipped: number
    cancelled: number
    avg_ship_seconds: number | null
  }
  balances: Balance[]
}

export interface CustomerFilter {
  /** Part of the email or name, any case. */
  q?: string
  /** Keyset on (created_at, id), newest first. */
  before?: { at: string; id: string }
  limit?: number
}

export interface CustomerRow {
  id: string
  email: string
  name: string
  created_at: string
  verified: boolean
  two_factor: boolean
  /** Paid orders placed signed in. */
  orders: number
  last_order_at: string | null
  /** The total charged on those orders, per order currency. */
  spend: Amount[]
}

export interface CustomerPage {
  customers: CustomerRow[]
  /** Paid orders placed signed out, all time, only ever as a sum: a guest has no account to list. On the first page only. */
  guests: { orders: number; spend: Amount[] } | null
}

export interface CustomerDetail extends CustomerRow {
  /** Refunded on those orders, per line currency. */
  refunded: Amount[]
  /** Every merchant whose order `recent` shows: the audit records the read against each. */
  merchant_ids: string[]
  /** Newest first, at most CUSTOMER_ORDERS. */
  recent: { id: string; created_at: string; currency: string; total: number; items: number; fulfilment: FulfilmentStatus[] }[]
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

/** Every field narrows; none given is every paid order in scope. */
export interface OrderFilter extends Partial<OrderRange> {
  /** The in-scope part of the order is in this state (for the platform: any part). */
  status?: FulfilmentStatus
  /** Part of the order id, any case. */
  q?: string
  /**
   * Orders with a line of this merchant's, and `status` read on that merchant's
   * part. It narrows and never widens: it is ANDed with the tenant clause, so
   * on a merchant read, naming another merchant finds nothing.
   */
  merchant?: string
  /** Keyset: only orders placed strictly before this one, in list order. */
  before?: { at: string; id: string }
  limit?: number
}

export interface InventoryRow {
  id: string
  merchant_id: string
  sku: string
  title: string
  category: string
  status: string
  price_minor: number
  currency: string
  stock_count: number
  /** Units on paid orders in the last 30 days (UTC), less refunded units. */
  sold_30d: number
}

export interface Queue {
  /** Parts of paid orders still pending. */
  to_ship: number
  /** Published, 1 to LOW_STOCK units left. */
  low_stock: number
  /** Published, none left. */
  out_of_stock: number
  /** Return requests still waiting for a decision. */
  returns_open: number
}

export type ReturnStatus = 'open' | 'approved' | 'rejected'
/** What a shopper may give as the reason for a return. The table's CHECK holds the same list. */
export const RETURN_REASONS = ['damaged', 'wrong_item', 'not_as_described', 'changed_mind', 'other'] as const
export type ReturnReason = (typeof RETURN_REASONS)[number]

/** One shopper's request for money back on one merchant's delivered part of an order. */
export interface ReturnSummary {
  id: string
  order_id: string
  merchant_id: string
  reason: ReturnReason
  note: string
  status: ReturnStatus
  /** What the approval refunded, in `currency`; null until approved. */
  refund_minor: number | null
  /** The part's lines' currency, or XXX when they span more than one. */
  currency: string
  decision_note: string | null
  decided_at: string | null
  created_at: string
  delivered_at: string | null
}

export interface ReturnDetail extends ReturnSummary {
  /** The part's lines, with what was paid and refunded on each. */
  lines: {
    product_id: string
    variant: string
    sku: string
    title: string
    qty: number
    unit_price_cents: number
    paid: number
    refunded_minor: number
  }[]
  /** Minor units still refundable across the part: the most an approval can refund. */
  refundable: number
  /** Photo names, oldest first: returnKey(id, name) in the private bucket. */
  photos: string[]
}

/** A review as staff see it: the author as a first name and initial, never an email. */
export interface ReviewRow {
  id: string
  product_id: string
  product_title: string
  merchant_id: string
  rating: number
  body: string
  hidden: boolean
  author: string
  /** Photo names, oldest first: reviewKey(id, name, size) in the public bucket. */
  photos: string[]
  created_at: string
  updated_at: string
}

/**
 * One currency's sales in a period. Commission is the balance's rule applied
 * to the period's net per merchant (see Balance): so the periods of a year can
 * each drop a fraction of a minor unit that the all-time balance does not.
 */
export interface ReportTotals {
  currency: string
  gross: number
  /** Refunded on these orders, whenever the refund was made. */
  refunds: number
  net: number
  commission: number
  /** Net less commission: what these sales add to the payable balance. */
  earnings: number
  /** Orders with a line in scope. On a platform read, one per merchant part. */
  orders: number
  /** Units sold, before refunds. */
  units: number
}

export interface SalesReport {
  from: string
  to: string
  /** The same number of days, ending the day before `from`. */
  previous: OrderRange & { totals: ReportTotals[] }
  totals: ReportTotals[]
  /** Past 92 days a series of days would be too thin to read, so it goes by week. */
  bucket: 'day' | 'week'
  /** Only buckets with sales; `start` is the bucket's first day, counted from `from`. */
  series: { start: string; currency: string; net: number; gross: number }[]
  categories: { category: string; currency: string; gross: number; net: number; units: number }[]
  /** Every product sold in the range, best net first within each currency. */
  products: { product_id: string; title: string; currency: string; gross: number; net: number; units: number }[]
}

/**
 * Money in and out in date order, per merchant and currency.
 *
 * Sales are dated by the order, refunds and payouts by when they were made.
 * `commission` on an entry is what the entry moved the running commission by,
 * where running commission is Balance's floor taken on the rated sum to date
 * (each line at the rate it was sold at) — so the entries' commissions add up
 * to the balance's, and the last entry's `balance` is the balance's `available`.
 */
export interface Ledger {
  /** The merchant's rate now, which the next sale is charged; null on a platform read, which spans merchants. */
  current_bps: number | null
  /** Per merchant and currency with any activity up to the end of the range. */
  summary: {
    merchant_id: string
    currency: string
    opening: number
    sales: number
    refunds: number
    commission: number
    payouts: number
    closing: number
  }[]
  entries: {
    merchant_id: string
    currency: string
    at: string
    kind: 'sale' | 'refund' | 'payout'
    /** The order id, or the payout's reference. */
    ref: string
    /** Signed: a sale adds, a refund or payout takes away. */
    amount: number
    commission: number
    balance: number
  }[]
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
  /** The in-scope refunds, oldest first. */
  refunds: (Omit<Refund, 'order_id'> & { actor_scope: string; created_at: string })[]
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
/** A pending part of an order placed longer ago than this is overdue. */
export const OVERDUE_DAYS = 3
/** The most orders a customer's page lists. */
export const CUSTOMER_ORDERS = 100
/** The most return requests, and reviews, one console list returns. */
export const RETURN_CAP = 200
export const REVIEW_CAP = 200

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
 *
 * A clause carries as many values as it has `?`, in order: most have one.
 */
function where(parts: (readonly [string, ...unknown[]] | null)[]): { sql: string; args: unknown[] } {
  const live = parts.filter((p): p is readonly [string, ...unknown[]] => p !== null)
  return {
    sql: live.length ? ` WHERE ${live.map(([clause]) => clause).join(' AND ')}` : '',
    args: live.flatMap(([, ...values]) => values),
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
  'products.inventory',
  'orders.list',
  'orders.get',
  'stats.overview',
  'stats.queue',
  'stats.sales',
  'finance.balance',
  'finance.ledger',
  'finance.payouts',
  'reviews.list',
  'returns.list',
  'returns.get',
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
  'returns.approve',
  'returns.reject',
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
 * An order's own currency, for the money that belongs to the order rather
 * than to any line: shipping, tax and the total charged. Checkout adds every
 * line into one subtotal whatever its currency (orders.ts), so an order is in
 * a currency only when all of its lines are. One whose lines span two is in
 * none, and reads as XXX, the way a line with no product row does, rather
 * than being guessed into either.
 */
const ORDER_CURRENCY = (order: string) =>
  `(SELECT CASE WHEN COUNT(DISTINCT ${CURRENCY}) = 1 THEN MIN(${CURRENCY}) ELSE 'XXX' END
      FROM order_lines l LEFT JOIN products p ON p.id = l.product_id WHERE l.order_id = ${order}.id)`

/** A LIKE pattern matching `q` anywhere, its own % _ and \ taken literally (used with ESCAPE '\'). */
const contains = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

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

/*
 * The commission rule, in its two halves, written once so the balance, the
 * ledger and the reports cannot disagree about it (see Balance):
 *
 *   RATED    a line's net at the rate it was sold at, in minor units × bps
 *   FLOORED  a sum of RATED back to minor units, floored once on the sum
 *
 * SQLite integer division of non-negative integers is the floor. The ledger
 * signs RATED per event (a refund takes its line's rate back) and floors the
 * running sum; the balance and reports floor the sum per merchant and currency.
 */
const RATED = `(${NET} * l.commission_bps)`
const FLOORED = (rated: string) => `((${rated}) / 10000)`

/**
 * Every in-scope merchant's balance per currency, as one SELECT; see Balance
 * for the arithmetic. Shared by finance.balance and payouts.create, so the
 * figure a payout is checked against is the figure the page shows.
 *
 * Refunds and payouts take their currency the way lines do: refunds from the
 * product row, payouts as recorded (they were checked against it).
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
                         ${FLOORED(`SUM(${RATED})`)} AS commission
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

/** A balances() row finished: what is available, and whether it is owed to the platform instead. */
const withAvailable = (r: Omit<Balance, 'available' | 'owes'>): Balance => {
  const available = r.gross - r.refunds - r.commission - r.payouts
  return { ...r, available, owes: available < 0 }
}

/**
 * Mean seconds from an order being placed to a part of it shipping, over the
 * parts `f` (joined to their orders `o`) that shipped; NULL when none has.
 */
const AVG_SHIP = `CAST(ROUND(AVG((julianday(f.shipped_at) - julianday(o.created_at)) * 86400)) AS INTEGER)`

/**
 * Every in-scope line of a paid order placed in [from, to], with what the
 * reports read off it, as a subquery. Refunds are the line's, whenever made:
 * the same "net by the day the order was placed" the overview reports.
 */
function soldLines(scope: Scope, from: string, to: string): { sql: string; args: unknown[] } {
  const w = where([
    PAID,
    ['o.created_at >= ?', from],
    ["o.created_at < date(?, '+1 day')", to],
    tenant(scope, 'l.merchant_id'),
  ])
  return {
    sql: `SELECT l.merchant_id, o.id AS order_id, substr(o.created_at, 1, 10) AS day, ${CURRENCY} AS currency,
                 l.product_id, COALESCE(p.title, l.title) AS title, COALESCE(p.category, 'unknown') AS category,
                 l.qty AS units, ${GROSS} AS gross, ${REFUNDED_MINOR} AS refunds, ${RATED} AS rated
            ${SALES}${w.sql}`,
    args: w.args,
  }
}

/**
 * The ledger's events, as a subquery: one sale per order and currency (the
 * in-scope lines' gross), every refund, every payout. Amounts are signed the
 * way they move the balance, and so is `rated`: a sale adds its lines' gross
 * at their rates, a refund takes its amount back at its line's rate, a payout
 * is not commissioned. Summed over every event that is Σ RATED, the balance's
 * figure. `rank` orders a sale before a refund before a payout within the
 * same second, and `id` breaks what ties remain, so the running figures come
 * out the same on every read.
 */
function ledgerEvents(scope: Scope): { sql: string; args: unknown[] } {
  const sold = where([PAID, tenant(scope, 'l.merchant_id')])
  const back = where([tenant(scope, 'r.merchant_id')])
  const paid = where([tenant(scope)])
  return {
    sql: `SELECT l.merchant_id, ${CURRENCY} AS currency, o.created_at AS at, 1 AS rank, 'sale' AS kind,
                 o.id AS id, o.id AS ref, SUM(${GROSS}) AS amount, SUM(${GROSS} * l.commission_bps) AS rated
            ${SALES}${sold.sql}
           GROUP BY l.merchant_id, o.id, ${CURRENCY}
          UNION ALL
          SELECT r.merchant_id, ${CURRENCY}, r.created_at, 2, 'refund', r.id, r.order_id, -r.amount_minor,
                 -r.amount_minor * COALESCE(l.commission_bps, 0)
            FROM refunds r LEFT JOIN products p ON p.id = r.product_id
            LEFT JOIN order_lines l ON l.order_id = r.order_id AND l.product_id = r.product_id AND l.variant = r.variant${back.sql}
          UNION ALL
          SELECT merchant_id, currency, created_at, 3, 'payout', id, reference, -amount_minor, 0
            FROM payouts${paid.sql}`,
    args: [...sold.args, ...back.args, ...paid.args],
  }
}

/** Calendar arithmetic on `YYYY-MM-DD`, in UTC. */
const DAY_MS = 86_400_000
const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / DAY_MS
const dayOf = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10)
/** The same number of days as `range`, ending the day before it starts. */
function previousOf(range: OrderRange): OrderRange {
  const [from, to] = [dayNumber(range.from), dayNumber(range.to)]
  return { from: dayOf(2 * from - to - 1), to: dayOf(from - 1) }
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

/**
 * One refund and its audit row, as statements for the caller's batch — which
 * must end with refundCapGuard. The one way a refund is written: refunds.create
 * and returns.approve both build their batches from this.
 *
 * `onlyIf` names an audit row written earlier in the same batch; both
 * statements then land only if it exists, which is how an approval's refunds
 * follow its conditional status change (the pattern cancelEffects uses).
 */
function refundWrites(
  env: TenancyEnv,
  actor: Scope,
  orderId: string,
  line: { merchant_id: string; currency: string },
  r: { refundId: string; productId: string; variant: string; qty: number; amount: number; reason: string },
  onlyIf: string | null = null,
): D1PreparedStatement[] {
  const cond = onlyIf ? ' WHERE EXISTS (SELECT 1 FROM audit_log WHERE id = ?)' : ''
  const condArgs = onlyIf ? [onlyIf] : []
  return [
    env.ORDERS.prepare(
      `INSERT INTO refunds (id, order_id, merchant_id, product_id, variant, qty, amount_minor,
                            reason, actor_id, actor_scope)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${cond}`,
    ).bind(r.refundId, orderId, line.merchant_id, r.productId, r.variant, r.qty, r.amount, r.reason, actor.staffId, actor.kind, ...condArgs),
    env.ORDERS.prepare(
      `INSERT INTO audit_log (id, actor_id, actor_scope, merchant_id, action, subject, detail)
       SELECT ?, ?, ?, ?, 'refunds.create', ?, ?${cond}`,
    ).bind(
      id('aud'),
      actor.staffId,
      actor.kind,
      line.merchant_id,
      orderId,
      JSON.stringify({ refund_id: r.refundId, product_id: r.productId, variant: r.variant, qty: r.qty, amount_minor: r.amount, currency: line.currency }),
      ...condArgs,
    ),
  ]
}

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

      async names() {
        const { results } = await env.ORDERS.prepare(`SELECT id, name, status FROM merchants ORDER BY name, id`).all<{
          id: string
          name: string
          status: string
        }>()
        return results ?? []
      },

      async get(merchantId: string) {
        // The merchant's own tenant clause for the SQL, as payouts.create
        // does; the wrapper still records this as the platform's read.
        const b = balances({ kind: 'merchant', merchantId, staffId })
        const one = <T>(sql: string, ...args: unknown[]) => env.ORDERS.prepare(sql).bind(...args).first<T>()
        const [row, staff, counts, low, health, balance] = await Promise.all([
          one<Omit<MerchantDetail, 'staff' | 'products' | 'low' | 'health' | 'balances'>>(
            `SELECT id AS merchant_id, name, slug, status, created_at, settlement_currency, commission_bps
               FROM merchants WHERE id = ?`,
            merchantId,
          ),
          // Named columns: never the password hash, its salt or the TOTP secret.
          env.ORDERS.prepare(
            `SELECT id, email, role, totp_confirmed_at IS NOT NULL AS totp_enrolled, created_at
               FROM staff WHERE merchant_id = ? ORDER BY created_at, id`,
          )
            .bind(merchantId)
            .all<Omit<MerchantDetail['staff'][number], 'totp_enrolled'> & { totp_enrolled: number }>(),
          one<MerchantDetail['products']>(
            `SELECT COALESCE(SUM(status = 'draft'), 0) AS draft, COALESCE(SUM(status = 'published'), 0) AS published,
                    COALESCE(SUM(status = 'archived'), 0) AS archived,
                    COALESCE(SUM(status = 'published' AND stock_count BETWEEN 1 AND ?), 0) AS low_stock,
                    COALESCE(SUM(status = 'published' AND stock_count = 0), 0) AS out_of_stock
               FROM products WHERE merchant_id = ?`,
            LOW_STOCK,
            merchantId,
          ),
          env.ORDERS.prepare(
            `SELECT id, title, stock_count FROM products
              WHERE merchant_id = ? AND status = 'published' AND stock_count <= ?
              ORDER BY stock_count, title LIMIT 20`,
          )
            .bind(merchantId, LOW_STOCK)
            .all<MerchantDetail['low'][number]>(),
          // A seek on order_fulfilments_merchant_idx: this merchant's parts only.
          one<MerchantDetail['health']>(
            `SELECT COALESCE(SUM(f.status = 'pending'), 0) AS to_ship,
                    COALESCE(SUM(f.status = 'pending' AND o.created_at < date('now', ?)), 0) AS overdue,
                    COUNT(*) AS parts, COALESCE(SUM(f.shipped_at IS NOT NULL), 0) AS shipped,
                    COALESCE(SUM(f.status = 'cancelled'), 0) AS cancelled,
                    ${AVG_SHIP} AS avg_ship_seconds
               FROM order_fulfilments f JOIN orders o ON o.id = f.order_id
              WHERE f.merchant_id = ? AND o.payment_status = ?`,
            `-${OVERDUE_DAYS} days`,
            merchantId,
            'succeeded',
          ),
          env.ORDERS.prepare(`${b.sql} ORDER BY g.currency`)
            .bind(...b.args)
            .all<Omit<Balance, 'available' | 'owes'>>(),
        ])
        if (!row) return null
        return {
          ...row,
          staff: (staff.results ?? []).map((s) => ({ ...s, totp_enrolled: s.totp_enrolled === 1 })),
          products: counts!,
          low: low.results ?? [],
          health: health!,
          balances: (balance.results ?? []).map(withAvailable),
        }
      },

      async sales(merchantId: string, range: OrderRange) {
        const exists = await env.ORDERS.prepare(`SELECT 1 AS one FROM merchants WHERE id = ?`).bind(merchantId).first()
        if (!exists) return null
        const report = await salesReport(env, { kind: 'merchant', merchantId, staffId }, range)
        return { ...report, merchant_id: merchantId }
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

    payments: {
      async list(filter: PaymentFilter) {
        /*
         * One branch per kind, each narrowed by its own index before the
         * union: orders by orders_created_idx, refunds and payouts by their
         * created_at indexes (0014), or by merchant when one is named.
         * ponytail: the keyset is applied above the union, so each page
         * re-reads the range; push it into each branch if a range grows past
         * tens of thousands of entries.
         */
        const when = (col: string) =>
          [
            [`${col} >= ?`, filter.from],
            [`${col} < date(?, '+1 day')`, filter.to],
          ] as const
        const branches: { sql: string; args: unknown[] }[] = []
        if ((!filter.kind || filter.kind === 'charge') && filter.merchantId) {
          /*
           * Narrowed to one merchant, a charge is that merchant's goods on the
           * order, per currency of its lines: never the order's total, which
           * holds other merchants' goods, nor its shipping and tax, which
           * belong to the whole order. The id carries the currency so the
           * keyset stays unique when one order holds two.
           */
          const w = where([PAID, ...when('o.created_at'), ['l.merchant_id = ?', filter.merchantId]])
          branches.push({
            sql: `SELECT o.created_at AS at, 1 AS rank, 'charge' AS kind, o.id || '-' || ${CURRENCY} AS id, o.id AS ref,
                         json_array(l.merchant_id) AS merchant_ids, ${CURRENCY} AS currency, SUM(${GROSS}) AS amount,
                         SUM(${GROSS}) AS goods, NULL AS shipping, NULL AS tax
                    ${SALES}${w.sql}
                   GROUP BY o.id, ${CURRENCY}`,
            args: w.args,
          })
        } else if (!filter.kind || filter.kind === 'charge') {
          const w = where([PAID, ...when('o.created_at')])
          branches.push({
            sql: `SELECT o.created_at AS at, 1 AS rank, 'charge' AS kind, o.id AS id, o.id AS ref,
                         (SELECT json_group_array(DISTINCT m.merchant_id) FROM order_lines m WHERE m.order_id = o.id) AS merchant_ids,
                         ${ORDER_CURRENCY('o')} AS currency, o.total_cents AS amount, o.subtotal_cents AS goods,
                         o.shipping_cents AS shipping, o.tax_cents AS tax
                    FROM orders o${w.sql}`,
            args: w.args,
          })
        }
        if (!filter.kind || filter.kind === 'refund') {
          const w = where([...when('r.created_at'), filter.merchantId ? ['r.merchant_id = ?', filter.merchantId] : null])
          branches.push({
            sql: `SELECT r.created_at AS at, 2 AS rank, 'refund' AS kind, r.id AS id, r.order_id AS ref,
                         json_array(r.merchant_id) AS merchant_ids, ${CURRENCY} AS currency, -r.amount_minor AS amount,
                         NULL AS goods, NULL AS shipping, NULL AS tax
                    FROM refunds r LEFT JOIN products p ON p.id = r.product_id${w.sql}`,
            args: w.args,
          })
        }
        if (!filter.kind || filter.kind === 'payout') {
          const w = where([...when('y.created_at'), filter.merchantId ? ['y.merchant_id = ?', filter.merchantId] : null])
          branches.push({
            sql: `SELECT y.created_at AS at, 3 AS rank, 'payout' AS kind, y.id AS id, y.reference AS ref,
                         json_array(y.merchant_id) AS merchant_ids, y.currency AS currency, -y.amount_minor AS amount,
                         NULL AS goods, NULL AS shipping, NULL AS tax
                    FROM payouts y${w.sql}`,
            args: w.args,
          })
        }
        const union = branches.map((b) => b.sql).join('\n UNION ALL\n')
        const args = branches.flatMap((b) => b.args)
        const currency = filter.currency ? (['e.currency = ?', filter.currency] as const) : null
        const page = where([
          currency,
          filter.before ? ['(e.at, e.rank, e.id) < (?, ?, ?)', filter.before.at, filter.before.rank, filter.before.id] : null,
        ])
        const all = where([currency])
        const limit = filter.limit ?? ORDER_CAP
        const [entries, totals] = await Promise.all([
          env.ORDERS.prepare(
            `SELECT * FROM (${union}) e${page.sql} ORDER BY e.at DESC, e.rank DESC, e.id DESC LIMIT ?`,
          )
            .bind(...args, ...page.args, limit + 1)
            .all<Omit<PaymentEntry, 'merchant_ids'> & { merchant_ids: string }>(),
          env.ORDERS.prepare(
            `SELECT e.currency,
                    SUM(e.kind = 'charge') AS charges, SUM(CASE WHEN e.kind = 'charge' THEN e.amount ELSE 0 END) AS charged,
                    SUM(COALESCE(e.goods, 0)) AS goods, SUM(COALESCE(e.shipping, 0)) AS shipping,
                    SUM(COALESCE(e.tax, 0)) AS tax,
                    SUM(e.kind = 'refund') AS refunds, SUM(CASE WHEN e.kind = 'refund' THEN -e.amount ELSE 0 END) AS refunded,
                    SUM(e.kind = 'payout') AS payouts, SUM(CASE WHEN e.kind = 'payout' THEN -e.amount ELSE 0 END) AS paid_out
               FROM (${union}) e${all.sql}
              GROUP BY e.currency ORDER BY e.currency`,
          )
            .bind(...args, ...all.args)
            .all<PaymentPage['totals'][number]>(),
        ])
        const rows = (entries.results ?? []).map((e) => ({ ...e, merchant_ids: JSON.parse(e.merchant_ids) as string[] }))
        return {
          merchant_ids: [...new Set(rows.slice(0, limit).flatMap((e) => e.merchant_ids))],
          entries: rows,
          totals: totals.results ?? [],
        }
      },
    },

    analytics: {
      async report(range: OrderRange) {
        const previous = previousOf(range)
        const platform: Scope = { kind: 'platform', staffId }
        const now = soldLines(platform, range.from, range.to)
        const placed = (from: string) =>
          where([PAID, ['o.created_at >= ?', from], ["o.created_at < date(?, '+1 day')", range.to]])
        const both = placed(previous.from)
        const inRange = placed(range.from)
        const [charges, merchants, health, signups] = await Promise.all([
          env.ORDERS.prepare(
            `SELECT period, currency, COUNT(*) AS orders, SUM(guest) AS guests, SUM(goods) AS goods,
                    SUM(shipping) AS shipping, SUM(tax) AS tax, SUM(total) AS total
               FROM (SELECT CASE WHEN o.created_at >= ? THEN 'now' ELSE 'before' END AS period,
                            ${ORDER_CURRENCY('o')} AS currency, o.user_id IS NULL AS guest,
                            o.subtotal_cents AS goods, o.shipping_cents AS shipping, o.tax_cents AS tax,
                            o.total_cents AS total
                       FROM orders o${both.sql})
              GROUP BY period, currency ORDER BY currency, period`,
          )
            .bind(range.from, ...both.args)
            .all<PlatformReport['charges'][number] & { guests: number }>(),
          // The balance's commission rule, merchant by merchant, as stats.sales does.
          env.ORDERS.prepare(
            `SELECT s.merchant_id, COALESCE(m.name, s.merchant_id) AS name, s.currency,
                    SUM(s.gross) AS gross, SUM(s.refunds) AS refunds, SUM(s.gross) - SUM(s.refunds) AS net,
                    ${FLOORED('SUM(s.rated)')} AS commission, COUNT(DISTINCT s.order_id) AS orders, SUM(s.units) AS units
               FROM (${now.sql}) s LEFT JOIN merchants m ON m.id = s.merchant_id
              GROUP BY s.merchant_id, s.currency
              ORDER BY s.currency, net DESC, s.merchant_id`,
          )
            .bind(...now.args)
            .all<PlatformReport['merchants'][number]>(),
          env.ORDERS.prepare(
            `SELECT f.merchant_id, COUNT(*) AS parts, SUM(f.status = 'cancelled') AS cancelled,
                    SUM(f.shipped_at IS NOT NULL) AS shipped, ${AVG_SHIP} AS avg_ship_seconds
               FROM orders o JOIN order_fulfilments f ON f.order_id = o.id${inRange.sql}
              GROUP BY f.merchant_id ORDER BY f.merchant_id`,
          )
            .bind(...inRange.args)
            .all<PlatformReport['health'][number]>(),
          env.ORDERS.prepare(
            `SELECT date(?, printf('+%d days', (CAST(julianday(substr(created_at, 1, 10)) - julianday(?) AS INTEGER) / 7) * 7)) AS start,
                    COUNT(*) AS count
               FROM users WHERE created_at >= ? AND created_at < date(?, '+1 day')
              GROUP BY start ORDER BY start`,
          )
            .bind(range.from, range.from, range.from, range.to)
            .all<PlatformReport['signups'][number]>(),
        ])
        const rows = charges.results ?? []
        const current = rows.filter((c) => c.period === 'now')
        const guests = current.reduce((n, c) => n + c.guests, 0)
        const board = merchants.results ?? []
        const parts = health.results ?? []
        return {
          ...range,
          previous,
          charges: rows.map(({ guests: _g, ...c }) => c),
          merchants: board,
          health: parts,
          signups: signups.results ?? [],
          buyers: { accounts: current.reduce((n, c) => n + c.orders, 0) - guests, guests },
          merchant_ids: [...new Set([...board.map((m) => m.merchant_id), ...parts.map((h) => h.merchant_id)])],
        }
      },

      async attention() {
        const b = balances({ kind: 'platform', staffId })
        const [counts, owing, owingCount, low] = await Promise.all([
          // Platform-wide, so pending parts are found by order_fulfilments_status_idx (0014).
          env.ORDERS.prepare(
            `SELECT (SELECT COUNT(*) FROM merchants WHERE status = 'pending') AS pending_applications,
                    COUNT(*) AS to_ship, COALESCE(SUM(o.created_at < date('now', ?)), 0) AS overdue
               FROM order_fulfilments f JOIN orders o ON o.id = f.order_id
              WHERE f.status = 'pending' AND o.payment_status = ?`,
          )
            .bind(`-${OVERDUE_DAYS} days`, 'succeeded')
            .first<Pick<Attention, 'pending_applications' | 'to_ship' | 'overdue'>>(),
          // ponytail: every balance from all history, as /api/platform/balances
          // reads it. A running balance table when history makes this slow.
          env.ORDERS.prepare(
            `SELECT b.merchant_id, mm.name, b.currency, b.gross - b.refunds - b.commission - b.payouts AS available
               FROM (${b.sql}) b JOIN merchants mm ON mm.id = b.merchant_id
              WHERE b.gross - b.refunds - b.commission - b.payouts < 0
              ORDER BY available, b.merchant_id LIMIT 20`,
          )
            .bind(...b.args)
            .all<Attention['owing'][number]>(),
          env.ORDERS.prepare(
            `SELECT COUNT(DISTINCT b.merchant_id) AS n FROM (${b.sql}) b
              WHERE b.gross - b.refunds - b.commission - b.payouts < 0`,
          )
            .bind(...b.args)
            .first<{ n: number }>(),
          env.ORDERS.prepare(
            `SELECT p.merchant_id, m.name, COUNT(*) AS products
               FROM products p JOIN merchants m ON m.id = p.merchant_id
              WHERE p.status = 'published' AND p.stock_count <= ? AND m.status = 'active'
              GROUP BY p.merchant_id ORDER BY products DESC, m.name LIMIT 20`,
          )
            .bind(LOW_STOCK)
            .all<Attention['low_stock'][number]>(),
        ])
        const o = owing.results ?? []
        const l = low.results ?? []
        return {
          ...(counts ?? { pending_applications: 0, to_ship: 0, overdue: 0 }),
          owing: o,
          owing_merchants: owingCount?.n ?? 0,
          low_stock: l,
          merchant_ids: [...new Set([...o.map((r) => r.merchant_id), ...l.map((r) => r.merchant_id)])],
        }
      },
    },

    customers: {
      async list(filter: CustomerFilter) {
        const w = where([
          filter.q ? ["(u.email LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\')", contains(filter.q), contains(filter.q)] : null,
          filter.before ? ['(u.created_at, u.id) < (?, ?)', filter.before.at, filter.before.id] : null,
        ])
        const [page, guests] = await Promise.all([
          env.ORDERS.prepare(
            `WITH picked AS (
               SELECT ${ACCOUNT} FROM users u${w.sql}
                ORDER BY u.created_at DESC, u.id DESC LIMIT ?
             ),
             paid AS (
               SELECT o.user_id, o.created_at, o.total_cents, ${ORDER_CURRENCY('o')} AS currency
                 FROM picked JOIN orders o ON o.user_id = picked.id
                WHERE o.payment_status = ?
             )
             SELECT picked.id, picked.email, picked.name, picked.created_at, picked.verified, picked.two_factor,
                    (SELECT COUNT(*) FROM paid WHERE paid.user_id = picked.id) AS orders,
                    (SELECT MAX(paid.created_at) FROM paid WHERE paid.user_id = picked.id) AS last_order_at,
                    (SELECT json_group_array(json_object('currency', currency, 'minor', minor))
                       FROM (SELECT currency, SUM(total_cents) AS minor FROM paid
                              WHERE paid.user_id = picked.id GROUP BY currency ORDER BY currency)) AS spend
               FROM picked ORDER BY picked.created_at DESC, picked.id DESC`,
          )
            .bind(...w.args, (filter.limit ?? ORDER_CAP) + 1, 'succeeded')
            .all<AccountRow & { orders: number; last_order_at: string | null; spend: string }>(),
          // The first page only; the next ones are the same accounts' neighbours.
          // ponytail: sums every guest order ever; a running total if that grows slow.
          filter.before
            ? null
            : env.ORDERS.prepare(
                `SELECT currency, COUNT(*) AS orders, SUM(total_cents) AS minor
                   FROM (SELECT o.total_cents, ${ORDER_CURRENCY('o')} AS currency
                           FROM orders o WHERE o.user_id IS NULL AND o.payment_status = ?)
                  GROUP BY currency ORDER BY currency`,
              )
                .bind('succeeded')
                .all<Amount & { orders: number }>(),
        ])
        const g = guests?.results ?? []
        return {
          customers: (page.results ?? []).map((c) => ({ ...account(c), orders: c.orders, last_order_at: c.last_order_at, spend: JSON.parse(c.spend) as Amount[] })),
          guests: guests ? { orders: g.reduce((n, r) => n + r.orders, 0), spend: amountsOf(g) } : null,
        }
      },

      async get(userId: string) {
        const [user, spent, refunded, recent] = await Promise.all([
          env.ORDERS.prepare(`SELECT ${ACCOUNT} FROM users u WHERE u.id = ?`).bind(userId).first<AccountRow>(),
          env.ORDERS.prepare(
            `SELECT currency, COUNT(*) AS orders, SUM(total_cents) AS minor, MAX(created_at) AS last
               FROM (SELECT o.created_at, o.total_cents, ${ORDER_CURRENCY('o')} AS currency
                       FROM orders o WHERE o.user_id = ? AND o.payment_status = ?)
              GROUP BY currency ORDER BY currency`,
          )
            .bind(userId, 'succeeded')
            .all<Amount & { orders: number; last: string }>(),
          env.ORDERS.prepare(
            `SELECT ${CURRENCY} AS currency, SUM(r.amount_minor) AS minor
               FROM orders o JOIN refunds r ON r.order_id = o.id LEFT JOIN products p ON p.id = r.product_id
              WHERE o.user_id = ? AND o.payment_status = ?
              GROUP BY ${CURRENCY} ORDER BY ${CURRENCY}`,
          )
            .bind(userId, 'succeeded')
            .all<Amount>(),
          env.ORDERS.prepare(
            `SELECT o.id, o.created_at, ${ORDER_CURRENCY('o')} AS currency, o.total_cents AS total,
                    (SELECT COALESCE(SUM(q.qty), 0) FROM order_lines q WHERE q.order_id = o.id) AS items,
                    (SELECT json_group_array(DISTINCT q.merchant_id) FROM order_lines q WHERE q.order_id = o.id) AS merchant_ids,
                    (SELECT json_group_array(status) FROM (
                       SELECT f.status FROM order_fulfilments f WHERE f.order_id = o.id ORDER BY f.merchant_id)) AS fulfilment
               FROM orders o WHERE o.user_id = ? AND o.payment_status = ?
              ORDER BY o.created_at DESC, o.id DESC LIMIT ?`,
          )
            .bind(userId, 'succeeded', CUSTOMER_ORDERS)
            .all<Omit<CustomerDetail['recent'][number], 'fulfilment'> & { fulfilment: string; merchant_ids: string }>(),
        ])
        if (!user) return null
        const s = spent.results ?? []
        const orders = recent.results ?? []
        return {
          ...account(user),
          orders: s.reduce((n, r) => n + r.orders, 0),
          last_order_at: s.reduce<string | null>((m, r) => (m === null || r.last > m ? r.last : m), null),
          spend: amountsOf(s),
          refunded: amountsOf(refunded.results ?? []),
          recent: orders.map(({ merchant_ids: _m, ...o }) => ({ ...o, fulfilment: JSON.parse(o.fulfilment) as FulfilmentStatus[] })),
          // Each merchant whose order this page shows finds the read in its own log, as with orders.list.
          merchant_ids: [...new Set(orders.flatMap((o) => JSON.parse(o.merchant_ids) as string[]))],
        }
      },
    },

    moderation: {
      hide: (reviewId: string) => setHidden(env, reviewId, true),
      unhide: (reviewId: string) => setHidden(env, reviewId, false),
    },
  }
}

/**
 * A review in or out of the product page. updated_at is the author's last
 * edit, so moderation leaves it alone; the audit log is where this is dated.
 */
async function setHidden(env: TenancyEnv, reviewId: string, hidden: boolean) {
  const { meta } = await env.ORDERS.prepare(`UPDATE reviews SET hidden = ? WHERE id = ?`).bind(hidden ? 1 : 0, reviewId).run()
  if (meta.changes !== 1) return null
  const row = await env.ORDERS.prepare(`SELECT id, merchant_id FROM reviews WHERE id = ?`)
    .bind(reviewId)
    .first<{ id: string; merchant_id: string }>()
  return row && { ...row, hidden }
}

/**
 * The only columns of `users` the console ever reads. Named one by one: never
 * the password hash or salt, the TOTP secret, or anything the tokens, sessions
 * and recovery codes tables hold. Whether a second factor is on is a boolean
 * computed here, so the secret it is computed from never leaves the query.
 */
const ACCOUNT = `u.id, u.email, u.name, u.created_at, u.email_verified_at IS NOT NULL AS verified,
                 u.totp_confirmed_at IS NOT NULL AS two_factor`
type AccountRow = { id: string; email: string; name: string; created_at: string; verified: number; two_factor: number }
const account = (r: AccountRow) => ({
  id: r.id,
  email: r.email,
  name: r.name,
  created_at: r.created_at,
  verified: r.verified === 1,
  two_factor: r.two_factor === 1,
})

/**
 * stats.sales, as a function of the scope it reads in: a merchant's own
 * repository, the platform's, and the platform reading one merchant
 * (merchants.sales) all run this one body, so the three cannot disagree.
 */
async function salesReport(env: TenancyEnv, scope: Scope, range: OrderRange): Promise<SalesReport> {
  const days = dayNumber(range.to) - dayNumber(range.from) + 1
  const previous = previousOf(range)
  const size = days > 92 ? 7 : 1
  const both = soldLines(scope, previous.from, range.to)
  const now = soldLines(scope, range.from, range.to)

  const [totals, series, categories, products] = await Promise.all([
    // Both periods in one pass. Commission per merchant first, each line
    // at its own rate and floored on the merchant's sum, then summed: the
    // balance's rule, merchant by merchant.
    //
    // ponytail: like the order history, each of these four statements
    // reads all the merchant's lines and filters by date after the join,
    // so a report costs O(merchant history), not O(range). The same
    // upgrade applies: a placed_at the merchant index reaches
    // (order_fulfilments, indexed (merchant_id, placed_at)) to seek the range.
    env.ORDERS.prepare(
      `SELECT period, currency, SUM(gross) AS gross, SUM(refunds) AS refunds, SUM(commission) AS commission,
              SUM(orders) AS orders, SUM(units) AS units
         FROM (SELECT CASE WHEN s.day >= ? THEN 'now' ELSE 'before' END AS period, s.merchant_id, s.currency,
                      SUM(s.gross) AS gross, SUM(s.refunds) AS refunds,
                      ${FLOORED('SUM(s.rated)')} AS commission,
                      COUNT(DISTINCT s.order_id) AS orders, SUM(s.units) AS units
                 FROM (${both.sql}) s
                GROUP BY period, s.merchant_id, s.currency)
        GROUP BY period, currency ORDER BY currency`,
    )
      .bind(range.from, ...both.args)
      .all<Omit<ReportTotals, 'net' | 'earnings'> & { period: 'now' | 'before' }>(),
    // The size is cast because a bound number can arrive as a REAL, and
    // integer division by 7.0 is not integer division.
    env.ORDERS.prepare(
      `SELECT date(?, printf('+%d days', (CAST(julianday(day) - julianday(?) AS INTEGER) / CAST(? AS INTEGER)) * ?)) AS start,
              currency, SUM(gross - refunds) AS net, SUM(gross) AS gross
         FROM (${now.sql})
        GROUP BY start, currency ORDER BY start, currency`,
    )
      .bind(range.from, range.from, size, size, ...now.args)
      .all<SalesReport['series'][number]>(),
    env.ORDERS.prepare(
      `SELECT category, currency, SUM(gross) AS gross, SUM(gross - refunds) AS net, SUM(units) AS units
         FROM (${now.sql})
        GROUP BY currency, category ORDER BY currency, net DESC, category`,
    )
      .bind(...now.args)
      .all<SalesReport['categories'][number]>(),
    env.ORDERS.prepare(
      `SELECT product_id, MAX(title) AS title, currency, SUM(gross) AS gross, SUM(gross - refunds) AS net,
              SUM(units) AS units
         FROM (${now.sql})
        GROUP BY currency, product_id ORDER BY currency, net DESC, product_id`,
    )
      .bind(...now.args)
      .all<SalesReport['products'][number]>(),
  ])

  const period = (p: 'now' | 'before'): ReportTotals[] =>
    (totals.results ?? [])
      .filter((r) => r.period === p)
      .map(({ currency, gross, refunds, commission, orders, units }) => ({
        currency,
        gross,
        refunds,
        net: gross - refunds,
        commission,
        earnings: gross - refunds - commission,
        orders,
        units,
      }))
  return {
    ...range,
    previous: { ...previous, totals: period('before') },
    totals: period('now'),
    bucket: size === 7 ? ('week' as const) : ('day' as const),
    series: series.results ?? [],
    categories: categories.results ?? [],
    products: products.results ?? [],
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

  /** Return requests in scope matching `clauses`, newest first, with their part's currency and delivery date. */
  const returnRows = async (clauses: (readonly [string, ...unknown[]] | null)[]) => {
    const w = where([...clauses, tenant(scope, 'rr.merchant_id')])
    const { results } = await env.ORDERS.prepare(
      `SELECT rr.id, rr.order_id, rr.merchant_id, rr.reason, rr.note, rr.status, rr.refund_minor,
              (SELECT CASE WHEN COUNT(DISTINCT ${CURRENCY}) = 1 THEN MIN(${CURRENCY}) ELSE 'XXX' END
                 FROM order_lines l LEFT JOIN products p ON p.id = l.product_id
                WHERE l.order_id = rr.order_id AND l.merchant_id = rr.merchant_id) AS currency,
              rr.decision_note, rr.decided_at, rr.created_at, f.delivered_at
         FROM return_requests rr
         LEFT JOIN order_fulfilments f ON f.order_id = rr.order_id AND f.merchant_id = rr.merchant_id${w.sql}
        ORDER BY rr.created_at DESC, rr.id DESC
        LIMIT ?`,
    )
      .bind(...w.args, RETURN_CAP)
      .all<ReturnSummary>()
    return results ?? []
  }

  /** One request in scope, with its part's lines, what is left to refund and its photos. */
  const getReturn = async (returnId: string): Promise<ReturnDetail | null> => {
    const [row] = await returnRows([['rr.id = ?', returnId]])
    // Not this scope's: the same answer as no such request.
    if (!row) return null
    const [lines, photos] = await Promise.all([
      env.ORDERS.prepare(
        `SELECT l.product_id, l.variant, l.sku, l.title, l.qty, l.unit_price_cents,
                ${GROSS} AS paid, ${REFUNDED_MINOR} AS refunded_minor
           FROM order_lines l WHERE l.order_id = ? AND l.merchant_id = ?
          ORDER BY l.title, l.variant`,
      )
        .bind(row.order_id, row.merchant_id)
        .all<ReturnDetail['lines'][number]>(),
      env.ORDERS.prepare(`SELECT name FROM return_photos WHERE return_id = ? ORDER BY created_at, rowid`)
        .bind(returnId)
        .all<{ name: string }>(),
    ])
    const ls = lines.results ?? []
    return {
      ...row,
      lines: ls,
      refundable: ls.reduce((sum, l) => sum + l.paid - l.refunded_minor, 0),
      photos: (photos.results ?? []).map((p) => p.name),
    }
  }

  /** A decision's refusal when the request is not open any more. */
  const decided = (status: string) => new Conflict(`This return is already ${status}.`)

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

      async inventory() {
        // Sold is net of refunded units: a cancelled part refunds every unit,
        // so it reads as the zero demand it was.
        const sold = where([PAID, ['o.created_at >= ?', utcDay(29)], tenant(scope, 'l.merchant_id')])
        const own = where([tenant(scope, 'p.merchant_id')])
        const { results } = await env.ORDERS.prepare(
          `SELECT p.id, p.merchant_id, p.sku, p.title, p.category, p.status, p.price_minor, p.currency, p.stock_count,
                  COALESCE(s.units, 0) AS sold_30d
             FROM products p
             LEFT JOIN (SELECT l.product_id, SUM(l.qty - ${REFUNDED_QTY}) AS units
                          FROM order_lines l JOIN orders o ON o.id = l.order_id${sold.sql}
                         GROUP BY l.product_id) s ON s.product_id = p.id${own.sql}
            ORDER BY p.created_at DESC, p.id`,
        )
          .bind(...sold.args, ...own.args)
          .all<InventoryRow>()
        return results ?? []
      },
    },

    orders: {
      async list(filter: OrderFilter) {
        // The tenant clause is on the LINE, so an order shared with another
        // merchant appears here, but summed over this merchant's lines only.
        const parts = tenant(scope, 'f.merchant_id')
        const partClause = parts ? ` AND ${parts[0]}` : ''
        const partArgs = parts ? [parts[1]] : []
        // The status of the named merchant's part, when the list is narrowed to one.
        const narrowed = filter.merchant ? [' AND f.merchant_id = ?', filter.merchant] : ['']
        const picked = where([
          PAID,
          filter.from ? ['o.created_at >= ?', filter.from] : null,
          filter.to ? ["o.created_at < date(?, '+1 day')", filter.to] : null,
          // LIKE is ASCII case-insensitive; the pattern's own % and _ are escaped.
          filter.q ? ["o.id LIKE ? ESCAPE '\\'", contains(filter.q)] : null,
          filter.status
            ? [
                `EXISTS (SELECT 1 FROM order_fulfilments f WHERE f.order_id = o.id AND f.status = ?${partClause}${narrowed[0]})`,
                filter.status,
                ...partArgs,
                ...narrowed.slice(1),
              ]
            : null,
          filter.merchant ? ['l.merchant_id = ?', filter.merchant] : null,
          // Keyset on the list's own order, so a page never repeats or skips
          // an order however many arrive while someone reads.
          filter.before ? ['(o.created_at, o.id) < (?, ?)', filter.before.at, filter.before.id] : null,
          tenant(scope, 'l.merchant_id'),
        ])
        const mine = where([tenant(scope, 'l.merchant_id')])
        // The limit counts ORDERS, in the CTE. A LIMIT on the grouped rows below
        // would count an order once per currency, and cut an order in half.
        //
        // ponytail: every page reads all of the merchant's lines (a SEARCH on
        // order_lines_merchant_idx), joins each order, then sorts and cuts,
        // because the sort key (orders.created_at) is not on anything the
        // merchant id reaches. So a page costs O(merchant history) and the CSV
        // export O(pages × history). Upgrade when a seller's history makes a
        // page slow: copy placed_at onto order_fulfilments (one row per
        // merchant part) with an index (merchant_id, placed_at DESC, order_id)
        // and drive `picked` from it, so the cursor seeks straight to its page.
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
                      WHERE f.order_id = o.id${partClause}
                      ORDER BY f.merchant_id)) AS fulfilment
             FROM picked
             JOIN orders o ON o.id = picked.id
             JOIN order_lines l ON l.order_id = o.id
             LEFT JOIN products p ON p.id = l.product_id${mine.sql}
            GROUP BY o.id, ${CURRENCY}
            ORDER BY o.created_at DESC, o.id DESC, ${CURRENCY}`,
        )
          .bind(...picked.args, (filter.limit ?? ORDER_CAP) + 1, ...partArgs, ...mine.args)
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
        const r = where([['r.order_id = ?', orderId], tenant(scope, 'r.merchant_id')])
        const [lines, totals, parts, refunds] = await Promise.all([
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
          env.ORDERS.prepare(
            `SELECT r.id, r.merchant_id, r.product_id, r.variant, r.qty, r.amount_minor, ${CURRENCY} AS currency,
                    r.reason, r.actor_scope, r.created_at
               FROM refunds r LEFT JOIN products p ON p.id = r.product_id${r.sql}
              ORDER BY r.created_at, r.rowid`,
          )
            .bind(...r.args)
            .all<OrderDetail['refunds'][number]>(),
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
          refunds: refunds.results ?? [],
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
            ...refundWrites(env, scope, orderId, line, {
              refundId,
              productId: input.productId,
              variant: input.variant,
              qty: input.qty,
              amount,
              reason: input.reason,
            }),
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
        return (results ?? []).map(withAvailable)
      },

      async ledger(range: OrderRange) {
        const events = ledgerEvents(scope)
        const end = dayOf(dayNumber(range.to) + 1)
        /*
         * Running figures over the whole history, then cut to the range: an
         * entry's balance depends on everything before it. `net` is sales less
         * refunds to date, `paid` payouts to date; commission to date is
         * FLOORED of the rated sum to date, the balance's own rule, so each
         * entry's commission is how far it moved that figure.
         *
         * ponytail: every read runs the window over the merchant's whole
         * history, whatever month is asked for: O(history) per statement.
         * Upgrade with a monthly snapshot of the running figures (net, rated,
         * paid per merchant and currency), so a statement starts from the last
         * snapshot before `from` instead of the first sale.
         */
        const running = `
          SELECT e.*, SUM(CASE WHEN e.kind = 'payout' THEN 0 ELSE e.amount END) OVER w AS net,
                 SUM(CASE WHEN e.kind = 'payout' THEN -e.amount ELSE 0 END) OVER w AS paid,
                 ${FLOORED('SUM(e.rated) OVER w')} AS charged
            FROM (${events.sql}) e
          WINDOW w AS (PARTITION BY e.merchant_id, e.currency ORDER BY e.at, e.rank, e.id)`
        const [entries, summary, rate] = await Promise.all([
          env.ORDERS.prepare(
            `SELECT merchant_id, currency, at, kind, ref, amount, commission, balance FROM (
               SELECT merchant_id, currency, at, rank, id, kind, ref, amount,
                      charged - LAG(charged, 1, 0) OVER (PARTITION BY merchant_id, currency ORDER BY at, rank, id) AS commission,
                      net - charged - paid AS balance
                 FROM (${running}))
              WHERE at >= ? AND at < ?
              ORDER BY at, rank, id, currency`,
          )
            .bind(...events.args, range.from, end)
            .all<Ledger['entries'][number]>(),
          // Opening and closing from the balance's formula over the events
          // before each bound; the period's commission is the difference.
          env.ORDERS.prepare(
            `SELECT merchant_id, currency,
                    net_before - ${FLOORED('rated_before')} - paid_before AS opening,
                    sales, refunds, ${FLOORED('rated_through')} - ${FLOORED('rated_before')} AS commission,
                    payouts, net_through - ${FLOORED('rated_through')} - paid_through AS closing
               FROM (SELECT e.merchant_id, e.currency,
                            SUM(CASE WHEN e.at < ? AND e.kind <> 'payout' THEN e.amount ELSE 0 END) AS net_before,
                            SUM(CASE WHEN e.at < ? THEN e.rated ELSE 0 END) AS rated_before,
                            SUM(CASE WHEN e.at < ? AND e.kind = 'payout' THEN -e.amount ELSE 0 END) AS paid_before,
                            SUM(CASE WHEN e.at >= ? AND e.kind = 'sale' THEN e.amount ELSE 0 END) AS sales,
                            SUM(CASE WHEN e.at >= ? AND e.kind = 'refund' THEN -e.amount ELSE 0 END) AS refunds,
                            SUM(CASE WHEN e.at >= ? AND e.kind = 'payout' THEN -e.amount ELSE 0 END) AS payouts,
                            SUM(CASE WHEN e.kind <> 'payout' THEN e.amount ELSE 0 END) AS net_through,
                            SUM(e.rated) AS rated_through,
                            SUM(CASE WHEN e.kind = 'payout' THEN -e.amount ELSE 0 END) AS paid_through
                       FROM (${events.sql}) e
                      WHERE e.at < ?
                      GROUP BY e.merchant_id, e.currency)
              ORDER BY merchant_id, currency`,
          )
            .bind(...Array(6).fill(range.from), ...events.args, end)
            .all<Ledger['summary'][number]>(),
          scope.kind === 'merchant'
            ? env.ORDERS.prepare(`SELECT commission_bps FROM merchants WHERE id = ?`)
                .bind(scope.merchantId)
                .first<{ commission_bps: number }>()
            : null,
        ])
        return {
          current_bps: rate?.commission_bps ?? null,
          summary: summary.results ?? [],
          entries: entries.results ?? [],
        }
      },

      async payouts() {
        const w = where([tenant(scope)])
        const { results } = await env.ORDERS.prepare(
          `SELECT id, merchant_id, currency, amount_minor, reference, created_by, created_at
             FROM payouts${w.sql} ORDER BY created_at DESC, rowid DESC`,
        )
          .bind(...w.args)
          .all<Payout & { created_at: string }>()
        return results ?? []
      },
    },

    reviews: {
      async list({ limit }: { limit?: number }) {
        const w = where([tenant(scope, 'r.merchant_id')])
        const { results } = await env.ORDERS.prepare(
          `SELECT r.id, r.product_id, COALESCE(p.title, '') AS product_title, r.merchant_id, r.rating, r.body,
                  r.hidden, u.name AS author, r.created_at, r.updated_at,
                  (SELECT json_group_array(name) FROM (
                     SELECT name FROM review_photos WHERE review_id = r.id ORDER BY created_at, rowid)) AS photos
             FROM reviews r JOIN users u ON u.id = r.user_id
             LEFT JOIN products p ON p.id = r.product_id${w.sql}
            ORDER BY r.created_at DESC, r.id DESC
            LIMIT ?`,
        )
          .bind(...w.args, Math.min(limit ?? REVIEW_CAP, REVIEW_CAP))
          .all<Omit<ReviewRow, 'hidden' | 'photos'> & { hidden: number; photos: string }>()
        return (results ?? []).map((r) => ({
          ...r,
          hidden: r.hidden === 1,
          // The full name stays in the users table: staff see what shoppers see.
          author: authorOf(r.author),
          photos: JSON.parse(r.photos) as string[],
        }))
      },
    },

    returns: {
      list: ({ status }: { status?: ReturnStatus }) => returnRows([status ? ['rr.status = ?', status] : null]),

      get: getReturn,

      async approve(returnId: string, { amountMinor, note }: { amountMinor: number; note: string }) {
        const merchantId = own()
        assertIntegerMinor(amountMinor, 'amountMinor')
        if (amountMinor <= 0) throw new Invalid('An approval refunds some money: state an amount.')
        const r = await getReturn(returnId)
        if (!r) return null
        if (r.status !== 'open') throw decided(r.status)
        if (r.currency === 'XXX') {
          throw new Invalid('This part was sold in more than one currency. Refund its lines one at a time from the order.')
        }
        if (amountMinor > r.refundable) {
          throw new Conflict(`Only ${shown(r.refundable, r.currency)} is left to refund on this part.`)
        }
        // Each line takes what it still has, in order, until the amount is
        // placed. Money only (qty 0): a refund is money, not a restock.
        let left = amountMinor
        const refunds = r.lines.flatMap((l) => {
          const take = Math.min(left, l.paid - l.refunded_minor)
          left -= take
          return take > 0
            ? [{ refundId: id('rfd'), productId: l.product_id, variant: l.variant, qty: 0, amount: take, reason: `Return ${returnId} (${r.reason})` }]
            : []
        })
        const auditId = id('aud')
        try {
          const [update] = await env.ORDERS.batch([
            env.ORDERS.prepare(
              `UPDATE return_requests
                  SET status = 'approved', refund_minor = ?, decision_note = ?, decided_by = ?, decided_at = datetime('now')
                WHERE id = ? AND merchant_id = ? AND status = 'open'`,
            ).bind(amountMinor, note || null, scope.staffId, returnId, merchantId),
            env.ORDERS.prepare(
              `INSERT INTO audit_log (id, actor_id, actor_scope, merchant_id, action, subject, detail)
               SELECT ?, ?, ?, ?, 'returns.approve', ?, ? WHERE changes() = 1`,
            ).bind(
              auditId,
              scope.staffId,
              scope.kind,
              merchantId,
              returnId,
              JSON.stringify({ order_id: r.order_id, amount_minor: amountMinor, currency: r.currency, refund_ids: refunds.map((x) => x.refundId) }),
            ),
            // The refund path itself, each write conditional on the decision above.
            ...refunds.flatMap((x) => refundWrites(env, scope, r.order_id, { merchant_id: merchantId, currency: r.currency }, x, auditId)),
            refundCapGuard(env, r.order_id),
          ])
          if (update.meta.changes !== 1) throw new Conflict('This return changed in the meantime. Reload and try again.')
        } catch (err) {
          // The checks above read a moment ago; the guard reads now.
          if (overCap(err)) throw new Conflict('Another refund landed on this part in the meantime. Reload and try again.')
          throw err
        }
        return getReturn(returnId)
      },

      async reject(returnId: string, { note }: { note: string }) {
        const merchantId = own()
        if (!note.trim()) throw new Invalid('Say why, so the shopper knows: a rejection needs a note.')
        const r = await getReturn(returnId)
        if (!r) return null
        if (r.status !== 'open') throw decided(r.status)
        const [update] = await env.ORDERS.batch([
          env.ORDERS.prepare(
            `UPDATE return_requests
                SET status = 'rejected', decision_note = ?, decided_by = ?, decided_at = datetime('now')
              WHERE id = ? AND merchant_id = ? AND status = 'open'`,
          ).bind(note, scope.staffId, returnId, merchantId),
          env.ORDERS.prepare(
            `INSERT INTO audit_log (id, actor_id, actor_scope, merchant_id, action, subject, detail)
             SELECT ?, ?, ?, ?, 'returns.reject', ?, ? WHERE changes() = 1`,
          ).bind(id('aud'), scope.staffId, scope.kind, merchantId, returnId, JSON.stringify({ order_id: r.order_id, note })),
        ])
        if (update.meta.changes !== 1) throw new Conflict('This return changed in the meantime. Reload and try again.')
        return getReturn(returnId)
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

      async queue() {
        // Three counts, one statement. The first is a seek on
        // order_fulfilments_merchant_idx (merchant_id, status).
        const parts = where([['f.status = ?', 'pending'], PAID, tenant(scope, 'f.merchant_id')])
        const low = where([['status = ?', 'published'], ['stock_count BETWEEN 1 AND ?', LOW_STOCK], tenant(scope)])
        const out = where([['status = ?', 'published'], ['stock_count = ?', 0], tenant(scope)])
        // A seek on return_requests_merchant_idx (merchant_id, status).
        const open = where([['status = ?', 'open'], tenant(scope)])
        const row = await env.ORDERS.prepare(
          `SELECT (SELECT COUNT(*) FROM order_fulfilments f JOIN orders o ON o.id = f.order_id${parts.sql}) AS to_ship,
                  (SELECT COUNT(*) FROM products${low.sql}) AS low_stock,
                  (SELECT COUNT(*) FROM products${out.sql}) AS out_of_stock,
                  (SELECT COUNT(*) FROM return_requests${open.sql}) AS returns_open`,
        )
          .bind(...parts.args, ...low.args, ...out.args, ...open.args)
          .first<Queue>()
        return row ?? { to_ship: 0, low_stock: 0, out_of_stock: 0, returns_open: 0 }
      },

      sales: (range: OrderRange) => salesReport(env, scope, range),
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
    reviews: wrap('reviews', raw.reviews) as Repository['reviews'],
    returns: wrap('returns', raw.returns) as Repository['returns'],
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
    payments: wrapGroup(env, scope, 'payments', only.payments) as PlatformRepository['payments'],
    analytics: wrapGroup(env, scope, 'analytics', only.analytics) as PlatformRepository['analytics'],
    customers: wrapGroup(env, scope, 'customers', only.customers) as PlatformRepository['customers'],
    moderation: wrapGroup(env, scope, 'moderation', only.moderation) as PlatformRepository['moderation'],
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
