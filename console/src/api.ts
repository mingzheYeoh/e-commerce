/**
 * Typed fetch helpers for the routes this task's pages call.
 *
 * Same-origin relative paths only, per the plan: no base URL, no CORS
 * headers, no credentials in localStorage — the cookie the worker sets is
 * HttpOnly and travels with every same-origin request on its own. Every
 * function here just hands the status and parsed body back to the page that
 * called it; deciding what they mean is the page's job, not this file's.
 */

export type StaffMe =
  | { kind: null }
  | { kind: 'enrolling' }
  | { kind: 'active'; scope: 'platform' }
  | { kind: 'active'; scope: 'merchant'; merchant: { name: string; slug: string; status: string } }

export type ErrorBody = { error: string }

/** True for any response the worker refused, whatever it was trying to do. */
export const isError = (body: object): body is ErrorBody => 'error' in body

/**
 * A product, or the refusal to show in its place. `call` turns a non-JSON
 * answer (an edge 502 page) into {}, which is neither — and a page that took
 * {} for a product would throw reading its gallery.
 */
export const asProduct = (body: Product | ErrorBody): Product | ErrorBody =>
  isError(body) || 'id' in body ? body : { error: 'Something went wrong. Reload and try again.' }

async function call<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  })
  // A non-JSON body (a network error page, an empty 204) is read as {},
  // which every caller's isError() check reads as "not an error shape" —
  // safe because none of these routes has a meaningful empty success body.
  const body = (await res.json().catch(() => ({}))) as T
  return { status: res.status, body }
}

export const me = () => call<StaffMe>('/api/staff/me')

export const register = (input: { name: string; email: string; password: string }) =>
  call<{ pending: true; message: string } | ErrorBody>('/api/staff/register', {
    method: 'POST',
    body: JSON.stringify(input),
  })

export const signIn = (input: { email: string; password: string }) =>
  call<{ totpRequired: true; enrolled: boolean } | ErrorBody>('/api/staff/signin', {
    method: 'POST',
    body: JSON.stringify(input),
  })

export const signOut = () => call<Record<string, never>>('/api/staff/signout', { method: 'POST' })

export const totpBegin = () =>
  call<{ secret: string; uri: string } | ErrorBody>('/api/staff/totp/begin', { method: 'POST' })

export const totpConfirm = (code: string) =>
  call<ErrorBody | Record<string, never>>('/api/staff/totp/confirm', {
    method: 'POST',
    body: JSON.stringify({ code }),
  })

export type ProductStatus = 'draft' | 'published' | 'archived'

export type Product = {
  id: string
  merchantId: string
  sku: string
  title: string
  brand: string
  category: string
  priceMinor: number
  currency: string
  status: ProductStatus
  stockCount: number
  specsSummary: string[]
  specs: SpecRow[]
  /** Empty until the first photo; every URL in it was minted by the worker. */
  media: { heroImage?: string; hoverImage?: string; thumb?: string; gallery?: string[] }
}

export type SpecRow = { label: string; value: string }

export const listProducts = () => call<{ products: Product[] } | ErrorBody>('/api/merchant/products')

/** Create takes only what a new listing needs; stock and status start at the
 * worker's own defaults — set them on the edit page the caller lands on next. */
export const createProduct = (input: {
  sku: string
  title: string
  brand: string
  category: string
  priceMinor: number
}) => call<Product | ErrorBody>('/api/merchant/products', { method: 'POST', body: JSON.stringify(input) })

export const updateProduct = (
  id: string,
  patch: Partial<{
    title: string
    priceMinor: number
    stockCount: number
    status: ProductStatus
    category: string
    specsSummary: string[]
    specs: SpecRow[]
  }>,
) =>
  call<Product | ErrorBody>(`/api/merchant/products/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })

/**
 * One photo, already resized by the browser. Not through `call`: a FormData
 * body needs the browser to write its own multipart content-type, boundary
 * included, and `call` would overwrite it with JSON's.
 */
export async function uploadPhoto(id: string, large: Blob, thumb: Blob) {
  const form = new FormData()
  form.append('large', large, 'large.webp')
  form.append('thumb', thumb, 'thumb.webp')
  const res = await fetch(`/api/merchant/products/${id}/photos`, { method: 'POST', body: form })
  const body = (await res.json().catch(() => ({ error: `Upload failed (${res.status}).` }))) as Product | ErrorBody
  return { status: res.status, body }
}

export const makeMainPhoto = (id: string, name: string) =>
  call<Product | ErrorBody>(`/api/merchant/products/${id}/photos/${name}/main`, { method: 'POST' })

export const deletePhoto = (id: string, name: string) =>
  call<Product | ErrorBody>(`/api/merchant/products/${id}/photos/${name}`, { method: 'DELETE' })

export type PendingMerchant = { id: string; name: string; createdAt: string; email: string }

export const pendingMerchants = () =>
  call<{ merchants: PendingMerchant[] } | ErrorBody>('/api/platform/merchants')

/** One currency's amount. Totals are lists of these: currencies are never added together. */
export type Amount = { currency: string; minor: number }

export type Overview = {
  /** Net: goods on paid orders less their refunds. */
  revenue: { today: Amount[]; week: Amount[]; month: Amount[] }
  /** The same windows before refunds. */
  gross: { today: Amount[]; week: Amount[]; month: Amount[] }
  orders: { today: number; week: number; month: number }
  trend: { day: string; revenue: Amount[] }[]
  top: { productId: string; title: string; currency: string; minor: number; qty: number }[]
  lowStock: { id: string; title: string; stockCount: number }[]
  products: { draft: number; published: number; archived: number }
}

export type FulfilmentStatus = 'pending' | 'shipped' | 'delivered' | 'cancelled'

export type OrderSummary = {
  id: string
  placedAt: string
  method: string
  status: string
  items: number
  totals: Amount[]
  /** Your part's fulfilment: one entry for a merchant. */
  fulfilment: FulfilmentStatus[]
}

export type Fulfilment = {
  merchantId: string
  status: FulfilmentStatus
  carrier: string | null
  tracking: string | null
  shippedAt: string | null
  deliveredAt: string | null
  updatedAt: string
}

export type OrderLine = {
  productId: string
  merchantId: string
  sku: string
  title: string
  finish: string | null
  qty: number
  unitMinor: number
  currency: string
  refundedQty: number
  refundedMinor: number
}

export type OrderDetail = {
  id: string
  placedAt: string
  method: string
  status: string
  shipTo: { name: string; line1: string; line2: string; city: string; state: string; postal: string; country: string }
  lines: OrderLine[]
  /** Goods sold, before refunds. */
  totals: Amount[]
  fulfilment: Fulfilment[]
}

export type Refund = {
  id: string
  orderId: string
  productId: string
  finish: string | null
  qty: number
  amountMinor: number
  currency: string
  reason: string
}

export type MerchantStatus = 'pending' | 'active' | 'suspended'

export type MerchantSummary = {
  id: string
  name: string
  slug: string
  status: MerchantStatus
  createdAt: string
  productCount: number
  /** Last 30 days. */
  revenue: Amount[]
}

export type AuditEntry = {
  /** Insertion order; the last entry's is the page's `next` cursor. */
  seq: number
  id: string
  at: string
  actorId: string
  actorEmail: string | null
  actorScope: string
  merchantId: string | null
  merchantName: string | null
  action: string
  subject: string | null
}

export const merchantOverview = () => call<Overview | ErrorBody>('/api/merchant/overview')

/** One currency's settlement position, in minor units. `owes`: available is negative. */
export type Balance = {
  merchantId: string
  currency: string
  currentBps: number
  gross: number
  refunds: number
  commission: number
  payouts: number
  available: number
  owes: boolean
}

export const merchantBalance = () => call<{ balances: Balance[] } | ErrorBody>('/api/merchant/balance')

/** Only the filled-in values, so an empty field means "no filter" rather than "". */
const query = (params: Record<string, string | number | null | undefined>) =>
  new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => [k, String(v)]),
  )

export type OrderFilter = {
  from?: string
  to?: string
  status?: FulfilmentStatus | ''
  q?: string
  /** The previous page's `next`. */
  before?: string | null
  limit?: number
}

/** One page, newest first; `next` is null on the last. */
export const listOrders = (filter: OrderFilter) =>
  call<{ from: string | null; to: string | null; next: string | null; orders: OrderSummary[] } | ErrorBody>(
    `/api/merchant/orders?${query(filter)}`,
  )

export type Queue = { toShip: number; lowStock: number; outOfStock: number; lowStockAt: number }

export const merchantQueue = () => call<Queue | ErrorBody>('/api/merchant/queue')

export type ReportTotals = {
  currency: string
  gross: number
  refunds: number
  net: number
  commission: number
  earnings: number
  orders: number
  units: number
}

export type SalesReport = {
  from: string
  to: string
  bucket: 'day' | 'week'
  totals: ReportTotals[]
  previous: { from: string; to: string; totals: ReportTotals[] }
  series: { start: string; currency: string; net: number; gross: number }[]
  categories: { category: string; currency: string; gross: number; net: number; units: number }[]
  products: { productId: string; title: string; currency: string; gross: number; net: number; units: number }[]
}

export const salesReport = (from: string, to: string) =>
  call<SalesReport | ErrorBody>(`/api/merchant/reports/sales?${query({ from, to })}`)

export type InventoryItem = {
  id: string
  sku: string
  title: string
  category: string
  status: ProductStatus
  priceMinor: number
  currency: string
  stockCount: number
  sold30d: number
}

export const inventory = () => call<{ lowStockAt: number; products: InventoryItem[] } | ErrorBody>('/api/merchant/inventory')

export type LedgerEntry = {
  currency: string
  at: string
  kind: 'sale' | 'refund' | 'payout'
  ref: string
  amount: number
  commission: number
  balance: number
}

export type LedgerSummary = {
  currency: string
  opening: number
  sales: number
  refunds: number
  commission: number
  payouts: number
  closing: number
}

export const ledger = (from: string, to: string) =>
  call<
    | { from: string; to: string; currentBps: number | null; summary: LedgerSummary[]; entries: LedgerEntry[] }
    | ErrorBody
  >(`/api/merchant/finance/ledger?${query({ from, to })}`)

export type PayoutRow = { id: string; currency: string; amountMinor: number; reference: string; createdAt: string }

export const payouts = () => call<{ payouts: PayoutRow[] } | ErrorBody>('/api/merchant/finance/payouts')

export const getOrder = (id: string) => call<OrderDetail | ErrorBody>(`/api/merchant/orders/${encodeURIComponent(id)}`)

const orderAction = <T>(id: string, action: 'ship' | 'deliver' | 'cancel' | 'refunds', body: unknown = {}) =>
  call<T | ErrorBody>(`/api/merchant/orders/${encodeURIComponent(id)}/${action}`, {
    method: 'POST',
    body: JSON.stringify(body),
  })

/** Your part of the order, and only yours: pending -> shipped -> delivered, or pending -> cancelled. */
export const shipOrder = (id: string, carrier: string, tracking: string) =>
  orderAction<Fulfilment>(id, 'ship', { carrier, tracking })
export const deliverOrder = (id: string) => orderAction<Fulfilment>(id, 'deliver')
/** Also restocks your lines and refunds them in full. */
export const cancelOrder = (id: string) => orderAction<Fulfilment>(id, 'cancel')

/** qty 0 with an amount is money only; an amount left out is qty × the unit price. */
export const refundLine = (
  id: string,
  input: { productId: string; finish: string | null; qty: number; amountMinor?: number; reason: string },
) => orderAction<Refund>(id, 'refunds', input)

/** The platform overview carries no top products or low stock: its page shows neither. */
export type PlatformOverview = Omit<Overview, 'top' | 'lowStock'>

export const platformOverview = () =>
  call<{ overview: PlatformOverview; merchants: MerchantSummary[]; attention: Attention } | ErrorBody>('/api/platform/overview')

export const allMerchants = () => call<{ merchants: MerchantSummary[] } | ErrorBody>('/api/platform/merchants/all')

export const setMerchantStatus = (id: string, action: 'suspend' | 'restore') =>
  call<{ merchant_id: string; status: MerchantStatus } | ErrorBody>(`/api/platform/merchants/${id}/${action}`, {
    method: 'POST',
  })

/**
 * One page of the log, newest first. `before` is the previous page's `next`.
 * The page also carries every merchant's id and name for the filter, so the
 * viewer never reads the (audited per merchant) merchant list to fill it.
 */
export const auditLog = (merchantId: string | null, before: number | null) => {
  const q = new URLSearchParams()
  if (merchantId) q.set('merchant', merchantId)
  if (before !== null) q.set('before', String(before))
  return call<
    | { merchantId: string | null; next: number | null; merchants: { id: string; name: string }[]; entries: AuditEntry[] }
    | ErrorBody
  >(`/api/platform/audit?${q}`)
}

/* ------------------------------------------------------ platform back office */

export type Refunded = {
  id: string
  merchantId: string
  productId: string
  finish: string | null
  qty: number
  amountMinor: number
  currency: string
  reason: string
  /** Who refunded it: the merchant, or the platform on its behalf. */
  by: 'merchant' | 'platform'
  at: string
}

/** A platform read of an order: every merchant's lines, parts and refunds. */
export type PlatformOrderDetail = OrderDetail & { refunds: Refunded[] }

export type MerchantName = { id: string; name: string; status: MerchantStatus }

let names: Promise<MerchantName[]> | null = null
/**
 * Every merchant's id and name, for filters and labels. Read once per page
 * load and shared: each read is an audited platform read, and the names
 * change only when a merchant is approved.
 */
export function merchantNames(): Promise<MerchantName[]> {
  names ??= call<{ merchants: MerchantName[] } | ErrorBody>('/api/platform/merchants/names').then(({ body }) =>
    'merchants' in body ? body.merchants : [],
  )
  return names
}

export type PlatformOrderSummary = OrderSummary & { merchantIds: string[] }

export const platformOrders = (filter: OrderFilter & { merchant?: string }) =>
  call<{ from: string | null; to: string | null; next: string | null; orders: PlatformOrderSummary[] } | ErrorBody>(
    `/api/platform/orders?${query(filter)}`,
  )

export const platformOrder = (id: string) =>
  call<PlatformOrderDetail | ErrorBody>(`/api/platform/orders/${encodeURIComponent(id)}`)

/** Any merchant's line, under the same cap as the merchant's own refund. */
export const platformRefund = (
  id: string,
  input: { productId: string; finish: string | null; qty: number; amountMinor?: number; reason: string },
) =>
  call<Refund | ErrorBody>(`/api/platform/orders/${encodeURIComponent(id)}/refunds`, {
    method: 'POST',
    body: JSON.stringify(input),
  })

/** One merchant's pending part, cancelled on its behalf: restocked and refunded in full. */
export const cancelPart = (id: string, merchantId: string) =>
  call<Fulfilment | ErrorBody>(
    `/api/platform/orders/${encodeURIComponent(id)}/parts/${encodeURIComponent(merchantId)}/cancel`,
    { method: 'POST' },
  )

export type PaymentKind = 'charge' | 'refund' | 'payout'

export type PaymentEntry = {
  at: string
  kind: PaymentKind
  id: string
  ref: string
  merchantIds: string[]
  currency: string
  /** Signed as it moves the platform's cash: a charge in, a refund or payout out. */
  amount: number
  goods: number | null
  shipping: number | null
  tax: number | null
}

export type PaymentTotals = {
  currency: string
  charges: number
  charged: number
  goods: number
  shipping: number
  tax: number
  refunds: number
  refunded: number
  payouts: number
  paidOut: number
}

export type PaymentFilter = {
  from?: string
  to?: string
  type?: PaymentKind | ''
  merchant?: string
  currency?: string
  before?: string | null
  limit?: number
}

export const payments = (filter: PaymentFilter) =>
  call<{ from: string; to: string; next: string | null; entries: PaymentEntry[]; totals: PaymentTotals[] } | ErrorBody>(
    `/api/platform/payments?${query(filter)}`,
  )

export type PlatformReport = SalesReport & {
  charges: { period: 'now' | 'before'; currency: string; orders: number; goods: number; shipping: number; tax: number; total: number }[]
  merchants: {
    merchantId: string
    name: string
    currency: string
    gross: number
    refunds: number
    net: number
    commission: number
    orders: number
    units: number
  }[]
  health: { merchantId: string; parts: number; cancelled: number; shipped: number; avgShipSeconds: number | null }[]
  signups: { start: string; count: number }[]
  buyers: { accounts: number; guests: number }
}

export const platformReport = (from: string, to: string) =>
  call<PlatformReport | ErrorBody>(`/api/platform/reports?${query({ from, to })}`)

export type Customer = {
  id: string
  email: string
  name: string
  createdAt: string
  verified: boolean
  twoFactor: boolean
  orders: number
  lastOrderAt: string | null
  spend: Amount[]
}

export const customers = (q: string, before: string | null) =>
  call<
    | { next: string | null; customers: Customer[]; guests: { orders: number; spend: Amount[] } | null }
    | ErrorBody
  >(`/api/platform/customers?${query({ q, before })}`)

export type CustomerDetail = Customer & {
  refunded: Amount[]
  recent: { id: string; placedAt: string; currency: string; total: number; items: number; fulfilment: FulfilmentStatus[] }[]
}

export const customer = (id: string) => call<CustomerDetail | ErrorBody>(`/api/platform/customers/${encodeURIComponent(id)}`)

export type MerchantDetail = {
  id: string
  name: string
  slug: string
  status: MerchantStatus
  createdAt: string
  settlementCurrency: string
  commissionBps: number
  staff: { id: string; email: string; role: string; totpEnrolled: boolean; createdAt: string }[]
  products: { draft: number; published: number; archived: number; lowStock: number; outOfStock: number }
  low: { id: string; title: string; stockCount: number }[]
  lowStockAt: number
  health: {
    toShip: number
    overdue: number
    overdueDays: number
    parts: number
    shipped: number
    cancelled: number
    avgShipSeconds: number | null
  }
  balances: Balance[]
}

export const merchantDetail = (id: string) => call<MerchantDetail | ErrorBody>(`/api/platform/merchants/${encodeURIComponent(id)}`)

export const merchantSales = (id: string, from: string, to: string) =>
  call<SalesReport | ErrorBody>(`/api/platform/merchants/${encodeURIComponent(id)}/sales?${query({ from, to })}`)

export const setCommission = (id: string, commissionBps: number) =>
  call<{ merchantId: string; commissionBps: number } | ErrorBody>(`/api/platform/merchants/${encodeURIComponent(id)}/commission`, {
    method: 'POST',
    body: JSON.stringify({ commissionBps }),
  })

export const recordPayout = (id: string, input: { currency: string; amountMinor: number; reference: string }) =>
  call<{ id: string } | ErrorBody>(`/api/platform/merchants/${encodeURIComponent(id)}/payouts`, {
    method: 'POST',
    body: JSON.stringify(input),
  })

export type Attention = {
  pendingApplications: number
  toShip: number
  overdue: number
  overdueDays: number
  lowStockAt: number
  owing: { merchantId: string; name: string; currency: string; available: number }[]
  lowStock: { merchantId: string; name: string; products: number }[]
}

export const approveMerchant = (id: string, slug: string) =>
  call<{ id: string; status: string; slug: string } | ErrorBody>(`/api/platform/merchants/${id}/approve`, {
    method: 'POST',
    body: JSON.stringify({ slug }),
  })
