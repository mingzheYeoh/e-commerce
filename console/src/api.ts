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
  revenue: { today: Amount[]; week: Amount[]; month: Amount[] }
  orders: { today: number; week: number; month: number }
  trend: { day: string; revenue: Amount[] }[]
  top: { productId: string; title: string; currency: string; minor: number; qty: number }[]
  lowStock: { id: string; title: string; stockCount: number }[]
  products: { draft: number; published: number; archived: number }
}

export type OrderSummary = { id: string; placedAt: string; method: string; status: string; items: number; totals: Amount[] }

export type OrderDetail = {
  id: string
  placedAt: string
  method: string
  status: string
  shipTo: { name: string; line1: string; line2: string; city: string; state: string; postal: string; country: string }
  lines: { productId: string; sku: string; title: string; finish: string | null; qty: number; unitMinor: number; currency: string }[]
  totals: Amount[]
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
  return call<{ from: string; to: string; orders: OrderSummary[] } | ErrorBody>(`/api/merchant/orders?${q}`)
}

export const getOrder = (id: string) => call<OrderDetail | ErrorBody>(`/api/merchant/orders/${encodeURIComponent(id)}`)

export const platformOverview = () =>
  call<{ overview: Overview; merchants: MerchantSummary[] } | ErrorBody>('/api/platform/overview')

export const allMerchants = () => call<{ merchants: MerchantSummary[] } | ErrorBody>('/api/platform/merchants/all')

export const setMerchantStatus = (id: string, action: 'suspend' | 'restore') =>
  call<{ merchant_id: string; status: MerchantStatus } | ErrorBody>(`/api/platform/merchants/${id}/${action}`, {
    method: 'POST',
  })

export const auditLog = (merchantId: string | null, page: number) => {
  const q = new URLSearchParams({ page: String(page) })
  if (merchantId) q.set('merchant', merchantId)
  return call<{ merchantId: string | null; page: number; hasMore: boolean; entries: AuditEntry[] } | ErrorBody>(
    `/api/platform/audit?${q}`,
  )
}

export const approveMerchant = (id: string, slug: string) =>
  call<{ id: string; status: string; slug: string } | ErrorBody>(`/api/platform/merchants/${id}/approve`, {
    method: 'POST',
    body: JSON.stringify({ slug }),
  })
