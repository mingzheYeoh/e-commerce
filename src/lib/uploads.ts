/**
 * The shopper's uploads: avatar, reviews, return requests.
 *
 * Photos are resized here to webp with the console's own `toWebp` (one
 * pipeline, not two); the worker checks the bytes and the size again and
 * mints every storage key, so nothing in this file is a security boundary.
 * Every call sends the session cookie, like the rest of the account API.
 */
import { BASE } from './api'
import { toWebp } from '../../console/src/photos'

export type Result<T> = { ok: true; data: T } | { ok: false; error: string }

async function send<T>(path: string, init: RequestInit = {}): Promise<Result<T>> {
  try {
    const res = await fetch(`${BASE}${path}`, { credentials: 'include', signal: AbortSignal.timeout(30_000), ...init })
    const data = (await res.json().catch(() => ({}))) as T & { error?: string }
    return res.ok ? { ok: true, data } : { ok: false, error: data.error ?? 'Something went wrong. Try again.' }
  } catch {
    return { ok: false, error: 'Could not reach the server. Check your connection.' }
  }
}

const withJson = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

/** Resizes, then posts the named webp blobs as one multipart body. A photo the browser cannot read is an error, not a throw. */
async function upload<T>(path: string, file: File, sizes: Record<string, number>): Promise<Result<T>> {
  let blobs: [string, Blob][]
  try {
    blobs = await Promise.all(Object.entries(sizes).map(async ([field, side]) => [field, await toWebp(file, side)] as [string, Blob]))
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'That photo could not be read.' }
  }
  const form = new FormData()
  for (const [field, blob] of blobs) form.append(field, blob, `${field}.webp`)
  return send<T>(path, { method: 'POST', body: form })
}

/* ------------------------------------------------------------------ avatar */

export const uploadAvatar = (file: File) => upload<{ avatarUrl: string }>('/api/account/avatar', file, { photo: 256 })
export const removeAvatar = () => send<{ avatarUrl: null }>('/api/account/avatar', { method: 'DELETE' })

/* ----------------------------------------------------------------- reviews */

export interface Review {
  id: string
  /** First name and last initial. */
  author: string
  rating: number
  body: string
  photos: { large: string; thumb: string }[]
  createdAt: string
  updatedAt: string
  /** Only on the viewer's own review. */
  hidden?: boolean
}

export interface ReviewPage {
  average: number | null
  count: number
  page: number
  next: number | null
  reviews: Review[]
  /** Null when signed out. */
  viewer: { eligible: boolean; review: Review | null } | null
}

const productPath = (productId: string) => `/api/products/${encodeURIComponent(productId)}`

export const fetchReviews = (productId: string, page = 0) => send<ReviewPage>(`${productPath(productId)}/reviews?page=${page}`)
export const saveReview = (productId: string, rating: number, body: string) =>
  send<Review>(`${productPath(productId)}/review`, withJson('POST', { rating, body }))
export const deleteReview = (productId: string) => send<{ ok: true }>(`${productPath(productId)}/review`, { method: 'DELETE' })
export const addReviewPhoto = (productId: string, file: File) =>
  upload<Review>(`${productPath(productId)}/review/photos`, file, { large: 1600, thumb: 400 })
export const removeReviewPhoto = (productId: string, name: string) =>
  send<Review>(`${productPath(productId)}/review/photos/${encodeURIComponent(name)}`, { method: 'DELETE' })

/** A review photo's name, from its URL: .../<name>-1600.webp */
export const photoNameOf = (url: string) => url.match(/(ph_[a-z0-9]+)-(?:1600|400)\.webp$/)?.[1] ?? ''

/* ----------------------------------------------------------------- returns */

export type ReturnReason = 'damaged' | 'wrong_item' | 'not_as_described' | 'changed_mind' | 'other'

export const REASON_LABEL: Record<ReturnReason, string> = {
  damaged: 'Arrived damaged',
  wrong_item: 'Wrong item',
  not_as_described: 'Not as described',
  changed_mind: 'Changed my mind',
  other: 'Something else',
}

export interface ReturnRequest {
  id: string
  merchantId: string
  reason: ReturnReason
  note: string
  status: 'open' | 'approved' | 'rejected'
  refundMinor: number | null
  currency: string
  decisionNote: string | null
  createdAt: string
  decidedAt: string | null
  /** Paths on the API, served only to this account. */
  photos: string[]
}

export interface ReturnPart {
  merchantId: string
  seller: string
  status: string
  deliveredAt: string | null
  returnBy: string | null
  canRequest: boolean
  requests: ReturnRequest[]
}

export interface OrderReturnsView {
  returnDays: number
  reasons: ReturnReason[]
  parts: ReturnPart[]
}

const orderPath = (orderId: string) => `/api/account/orders/${encodeURIComponent(orderId)}/returns`

export const fetchOrderReturns = (orderId: string) => send<OrderReturnsView>(orderPath(orderId))
export const openReturn = (orderId: string, merchantId: string, reason: ReturnReason, note: string) =>
  send<ReturnRequest>(orderPath(orderId), withJson('POST', { merchantId, reason, note }))
export const addReturnPhoto = (returnId: string, file: File) =>
  upload<ReturnRequest>(`/api/account/returns/${encodeURIComponent(returnId)}/photos`, file, { photo: 1600 })

/** A private return photo's URL: on the API, which checks the session cookie before sending it. */
export const returnPhotoUrl = (path: string) => `${BASE}${path}`
