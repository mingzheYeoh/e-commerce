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

export const listOrders = (range: { from?: string; to?: string }) => {
  const q = new URLSearchParams(Object.entries(range).filter(([, v]) => v) as [string, string][])
  return call<{ from: string; to: string; truncated: boolean; orders: OrderSummary[] } | ErrorBody>(
    `/api/merchant/orders?${q}`,
  )
}

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
  call<{ overview: PlatformOverview; merchants: MerchantSummary[] } | ErrorBody>('/api/platform/overview')

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

export const approveMerchant = (id: string, slug: string) =>
  call<{ id: string; status: string; slug: string } | ErrorBody>(`/api/platform/merchants/${id}/approve`, {
    method: 'POST',
    body: JSON.stringify({ slug }),
  })
