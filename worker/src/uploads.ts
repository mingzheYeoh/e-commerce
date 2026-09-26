/**
 * What a signed-in shopper uploads: an avatar, product reviews with photos,
 * and return requests with photos.
 *
 * Scoped by the session, not by a merchant: every statement here names the
 * account in its WHERE (reviews.user_id, or orders.user_id for anything that
 * hangs off an order), so another account's rows read as no rows — the same
 * 404 as rows that do not exist. The staff side of reviews and returns is in
 * tenancy.ts, behind scopedTo / platformWide, like every other merchant read.
 *
 * Photos follow photos.ts: resized to webp in the browser, checked and keyed
 * here. Avatars and review photos are public (MEDIA, served by /media/u);
 * return photos are private (PRIVATE, served only through return-photos
 * routes that check who is asking).
 */
import {
  MAX_AVATAR_BYTES,
  MAX_LARGE_BYTES,
  MAX_RETURN_PHOTOS,
  MAX_REVIEW_PHOTOS,
  MAX_THUMB_BYTES,
  avatarKey,
  isPhotoName,
  isReturnKey,
  newPhotoName,
  readWebpForm,
  returnKey,
  reviewKey,
  reviewPhotoUrls,
} from './photos'
import { authorOf, clean } from './text'
import { id, RETURN_REASONS } from './tenancy'
import type { OrdersEnv } from './orders'
import type { User } from './auth'

export interface UploadsEnv extends OrdersEnv {
  /** Public photos: products (written by the console), avatars and review photos. */
  MEDIA?: R2Bucket
  /** Return photos. Never public. */
  PRIVATE?: R2Bucket
  /** Where nexus-api serves MEDIA from, ending in '/'. The console's value, per environment. */
  MEDIA_BASE?: string
}

export interface Reply {
  status: number
  body: unknown
}

const ok = (body: unknown, status = 200): Reply => ({ status, body })
const no = (status: number, error: string): Reply => ({ status, body: { error } })
const UNAVAILABLE = 'Photo uploads are not available right now.'
const META = { httpMetadata: { contentType: 'image/webp' } }
/** Storage cleanup after the row already stopped pointing at the object: an orphan, not a broken image. */
const orphaned = (keys: string | string[]) => (err: unknown) => console.error('orphaned photo objects', { keys, err })

const fields = (body: unknown): Record<string, unknown> =>
  typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}

/** Free text up to `max` characters, cleaned; empty is allowed. Null when too long or not text. */
const note = (v: unknown, max: number): string | null => {
  if (v === undefined || v === null) return ''
  if (typeof v !== 'string') return null
  const c = clean(v)
  return c.length <= max ? c : null
}

/* ------------------------------------------------------------------ avatar */

export const avatarUrl = (env: UploadsEnv, key: string | null): string | null =>
  key && env.MEDIA_BASE ? env.MEDIA_BASE + key : null

const avatarKeyOf = async (env: UploadsEnv, userId: string) =>
  (await env.ORDERS.prepare(`SELECT avatar_key FROM users WHERE id = ?1`).bind(userId).first<{ avatar_key: string | null }>())
    ?.avatar_key ?? null

/** The avatar URL for /api/auth/me, or null. */
export const avatarOf = async (env: UploadsEnv, userId: string) => avatarUrl(env, await avatarKeyOf(env, userId))

/**
 * Replaces the account's avatar: the new object first, then the row (only if
 * it still names the old one, so two uploads racing cannot strand each
 * other's object), then the old object goes.
 */
export async function setAvatar(env: UploadsEnv, user: User, request: Request): Promise<Reply> {
  if (!env.MEDIA) return no(503, UNAVAILABLE)
  const read = await readWebpForm(request, [{ field: 'photo', max: MAX_AVATAR_BYTES }])
  if (!Array.isArray(read)) return no(read.status, read.error)
  const old = await avatarKeyOf(env, user.id)
  const key = avatarKey(user.id, newPhotoName())
  await env.MEDIA.put(key, read[0], META)
  const { meta } = await env.ORDERS.prepare(`UPDATE users SET avatar_key = ?1 WHERE id = ?2 AND avatar_key IS ?3`)
    .bind(key, user.id, old)
    .run()
  if (meta.changes !== 1) {
    await env.MEDIA.delete(key).catch(orphaned(key))
    return no(409, 'Your photo changed while this one uploaded. Try again.')
  }
  if (old) await env.MEDIA.delete(old).catch(orphaned(old))
  return ok({ avatarUrl: avatarUrl(env, key) })
}

export async function removeAvatar(env: UploadsEnv, user: User): Promise<Reply> {
  const old = await avatarKeyOf(env, user.id)
  if (old) {
    await env.ORDERS.prepare(`UPDATE users SET avatar_key = NULL WHERE id = ?1 AND avatar_key = ?2`).bind(user.id, old).run()
    await env.MEDIA?.delete(old).catch(orphaned(old))
  }
  return ok({ avatarUrl: null })
}

/**
 * Every public object this account owns, for account deletion: its avatar
 * and both sizes of every review photo. Read before the rows go (the reviews
 * cascade with the account). Return photos stay: they belong to an order,
 * which outlives the account, and are private anyway.
 */
export async function publicObjectsOf(env: UploadsEnv, userId: string): Promise<string[]> {
  const [avatar, photos] = await Promise.all([
    avatarKeyOf(env, userId),
    env.ORDERS.prepare(
      `SELECT ph.review_id, ph.name FROM review_photos ph JOIN reviews r ON r.id = ph.review_id WHERE r.user_id = ?1`,
    )
      .bind(userId)
      .all<{ review_id: string; name: string }>(),
  ])
  return [
    ...(avatar ? [avatar] : []),
    ...(photos.results ?? []).flatMap((p) => [reviewKey(p.review_id, p.name, 1600), reviewKey(p.review_id, p.name, 400)]),
  ]
}

/* ----------------------------------------------------------------- reviews */

/** One page of the product's reviews. */
export const REVIEW_PAGE = 10

/**
 * Whether this account received this product: an order of theirs holds it
 * and the part of that order that carries it was delivered.
 */
const received = (env: UploadsEnv, userId: string, productId: string) =>
  env.ORDERS.prepare(
    `SELECT 1 AS one FROM orders o
       JOIN order_lines l ON l.order_id = o.id
       JOIN order_fulfilments f ON f.order_id = o.id AND f.merchant_id = l.merchant_id
      WHERE o.user_id = ?1 AND l.product_id = ?2 AND o.payment_status = 'succeeded' AND f.status = 'delivered'
      LIMIT 1`,
  )
    .bind(userId, productId)
    .first()

interface ReviewRecord {
  id: string
  name: string
  rating: number
  body: string
  hidden: number
  created_at: string
  updated_at: string
  photos: string
}

const REVIEW_COLUMNS = `r.id, u.name, r.rating, r.body, r.hidden, r.created_at, r.updated_at,
  (SELECT json_group_array(name) FROM (
     SELECT name FROM review_photos WHERE review_id = r.id ORDER BY created_at, rowid)) AS photos`

/** A review as anyone may see it: the author's first name and initial, never who they are. */
const reviewOut = (env: UploadsEnv, r: ReviewRecord) => ({
  id: r.id,
  author: authorOf(r.name),
  rating: r.rating,
  body: r.body,
  photos: (JSON.parse(r.photos) as string[]).map((n) => reviewPhotoUrls(env.MEDIA_BASE ?? '', r.id, n)),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

/** The account's own review of the product, hidden or not, or null. */
const ownReview = (env: UploadsEnv, userId: string, productId: string) =>
  env.ORDERS.prepare(
    `SELECT ${REVIEW_COLUMNS} FROM reviews r JOIN users u ON u.id = r.user_id WHERE r.user_id = ?1 AND r.product_id = ?2`,
  )
    .bind(userId, productId)
    .first<ReviewRecord>()

const mine = (env: UploadsEnv, r: ReviewRecord) => ({ ...reviewOut(env, r), hidden: r.hidden === 1 })

/**
 * The product page's reviews: average and count of the visible ones, a page
 * newest first, and — for a signed-in viewer — whether they may write one
 * and the one they already wrote (even if hidden, so they know).
 */
export async function productReviews(env: UploadsEnv, productId: string, page: number, viewer: User | null): Promise<Reply> {
  const [summary, rows, own, eligible] = await Promise.all([
    env.ORDERS.prepare(`SELECT COUNT(*) AS count, AVG(rating) AS average FROM reviews WHERE product_id = ?1 AND hidden = 0`)
      .bind(productId)
      .first<{ count: number; average: number | null }>(),
    env.ORDERS.prepare(
      `SELECT ${REVIEW_COLUMNS} FROM reviews r JOIN users u ON u.id = r.user_id
        WHERE r.product_id = ?1 AND r.hidden = 0
        ORDER BY r.created_at DESC, r.id DESC LIMIT ?2 OFFSET ?3`,
    )
      .bind(productId, REVIEW_PAGE + 1, page * REVIEW_PAGE)
      .all<ReviewRecord>(),
    viewer ? ownReview(env, viewer.id, productId) : null,
    viewer ? received(env, viewer.id, productId) : null,
  ])
  const list = rows.results ?? []
  return ok({
    // One decimal, as the page shows it; null with nothing to average.
    average: summary?.average == null ? null : Math.round(summary.average * 10) / 10,
    count: summary?.count ?? 0,
    page,
    // ponytail: offset paging, fine for a product's reviews; keyset (as the console's lists use) if one gets thousands.
    next: list.length > REVIEW_PAGE ? page + 1 : null,
    reviews: list.slice(0, REVIEW_PAGE).map((r) => reviewOut(env, r)),
    viewer: viewer ? { eligible: Boolean(eligible), review: own ? mine(env, own) : null } : null,
  })
}

/** Writes the account's review of the product, or rewrites the one it already has. */
export async function saveReview(env: UploadsEnv, user: User, productId: string, body: unknown): Promise<Reply> {
  const p = fields(body)
  const rating = p.rating
  if (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    return no(400, 'Rate it from 1 to 5 stars.')
  }
  const text = note(p.body, 1000)
  if (text === null) return no(400, 'A review is 1000 characters at most.')
  const product = await env.ORDERS.prepare(`SELECT merchant_id FROM products WHERE id = ?1`)
    .bind(productId)
    .first<{ merchant_id: string }>()
  if (!product) return no(404, 'not found')
  if (!(await received(env, user.id, productId))) {
    return no(403, 'You can review this once your order of it has been delivered.')
  }
  // One statement, so two saves racing edit one review rather than refusing the second.
  await env.ORDERS.prepare(
    `INSERT INTO reviews (id, user_id, product_id, merchant_id, rating, body) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT (user_id, product_id) DO UPDATE SET rating = excluded.rating, body = excluded.body, updated_at = datetime('now')`,
  )
    .bind(id('rev'), user.id, productId, product.merchant_id, rating, text)
    .run()
  return ok(mine(env, (await ownReview(env, user.id, productId))!))
}

export async function deleteReview(env: UploadsEnv, user: User, productId: string): Promise<Reply> {
  const own = await ownReview(env, user.id, productId)
  if (!own) return no(404, 'not found')
  const names = JSON.parse(own.photos) as string[]
  await env.ORDERS.prepare(`DELETE FROM reviews WHERE id = ?1 AND user_id = ?2`).bind(own.id, user.id).run()
  const keys = names.flatMap((n) => [reviewKey(own.id, n, 1600), reviewKey(own.id, n, 400)])
  if (keys.length) await env.MEDIA?.delete(keys).catch(orphaned(keys))
  return ok({ ok: true })
}

/** One more photo on the account's review of the product: MAX_REVIEW_PHOTOS at most. */
export async function addReviewPhoto(env: UploadsEnv, user: User, productId: string, request: Request): Promise<Reply> {
  if (!env.MEDIA) return no(503, UNAVAILABLE)
  const own = await ownReview(env, user.id, productId)
  if (!own) return no(404, 'Write your review first, then add photos to it.')
  const full = no(409, `A review has at most ${MAX_REVIEW_PHOTOS} photos.`)
  if ((JSON.parse(own.photos) as string[]).length >= MAX_REVIEW_PHOTOS) return full
  const read = await readWebpForm(request, [
    { field: 'large', max: MAX_LARGE_BYTES },
    { field: 'thumb', max: MAX_THUMB_BYTES },
  ])
  if (!Array.isArray(read)) return no(read.status, read.error)
  const name = newPhotoName()
  const keys = [reviewKey(own.id, name, 1600), reviewKey(own.id, name, 400)]
  const cleanUp = () => env.MEDIA!.delete(keys).catch(orphaned(keys))
  try {
    await Promise.all([env.MEDIA.put(keys[0], read[0], META), env.MEDIA.put(keys[1], read[1], META)])
    // The cap is checked again by the statement that inserts, so two uploads racing cannot make four.
    const { meta } = await env.ORDERS.prepare(
      `INSERT INTO review_photos (review_id, name)
       SELECT ?1, ?2 WHERE (SELECT COUNT(*) FROM review_photos WHERE review_id = ?1) < ?3`,
    )
      .bind(own.id, name, MAX_REVIEW_PHOTOS)
      .run()
    if (meta.changes !== 1) {
      await cleanUp()
      return full
    }
  } catch (err) {
    // The objects went in first, so any failure after that takes them back out.
    await cleanUp()
    throw err
  }
  return ok(mine(env, (await ownReview(env, user.id, productId))!), 201)
}

export async function removeReviewPhoto(env: UploadsEnv, user: User, productId: string, name: string): Promise<Reply> {
  const own = await ownReview(env, user.id, productId)
  if (!own || !isPhotoName(name)) return no(404, 'not found')
  const { meta } = await env.ORDERS.prepare(`DELETE FROM review_photos WHERE review_id = ?1 AND name = ?2`).bind(own.id, name).run()
  if (meta.changes !== 1) return no(404, 'not found')
  const keys = [reviewKey(own.id, name, 1600), reviewKey(own.id, name, 400)]
  await env.MEDIA?.delete(keys).catch(orphaned(keys))
  return ok(mine(env, (await ownReview(env, user.id, productId))!))
}

/* ----------------------------------------------------------------- returns */

/** How long after delivery a return may be asked for. */
export const RETURN_DAYS = 30

const REASONS = new Set<string>(RETURN_REASONS)

/** Where the owner's browser fetches a return photo from (the API's own origin, with the session). */
export const returnPhotoPath = (returnId: string, name: string) => `/api/account/return-photos/${returnKey(returnId, name)}`

interface ReturnRecord {
  id: string
  merchant_id: string
  reason: string
  note: string
  status: string
  refund_minor: number | null
  currency: string
  decision_note: string | null
  created_at: string
  decided_at: string | null
  photos: string
}

const returnOut = (r: ReturnRecord) => ({
  id: r.id,
  merchantId: r.merchant_id,
  reason: r.reason,
  note: r.note,
  status: r.status,
  refundMinor: r.refund_minor,
  currency: r.currency,
  decisionNote: r.decision_note,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
  photos: (JSON.parse(r.photos) as string[]).map((n) => returnPhotoPath(r.id, n)),
})

/** The account's requests matching `where`, oldest first. `?1` is always the account. */
const returnRecords = (env: UploadsEnv, userId: string, clause: string, arg: string) =>
  env.ORDERS.prepare(
    `SELECT rr.id, rr.merchant_id, rr.reason, rr.note, rr.status, rr.refund_minor, rr.decision_note,
            rr.created_at, rr.decided_at,
            (SELECT CASE WHEN COUNT(DISTINCT COALESCE(p.currency, 'XXX')) = 1 THEN MIN(COALESCE(p.currency, 'XXX')) ELSE 'XXX' END
               FROM order_lines l LEFT JOIN products p ON p.id = l.product_id
              WHERE l.order_id = rr.order_id AND l.merchant_id = rr.merchant_id) AS currency,
            (SELECT json_group_array(name) FROM (
               SELECT name FROM return_photos WHERE return_id = rr.id ORDER BY created_at, rowid)) AS photos
       FROM return_requests rr JOIN orders o ON o.id = rr.order_id
      WHERE o.user_id = ?1 AND ${clause}
      ORDER BY rr.created_at, rr.id`,
  )
    .bind(userId, arg)
    .all<ReturnRecord>()

/**
 * Each seller's part of one of the account's orders, whether a return can be
 * asked for on it now, and every request made on it with its outcome.
 */
export async function orderReturns(env: UploadsEnv, user: User, orderId: string): Promise<Reply> {
  const [parts, requests] = await Promise.all([
    env.ORDERS.prepare(
      `SELECT f.merchant_id, COALESCE(m.name, '') AS seller, f.status, f.delivered_at,
              CASE WHEN f.delivered_at IS NULL THEN NULL ELSE datetime(f.delivered_at, ?3) END AS return_by,
              (f.status = 'delivered' AND julianday('now') <= julianday(f.delivered_at, ?3)) AS in_window
         FROM order_fulfilments f JOIN orders o ON o.id = f.order_id
         LEFT JOIN merchants m ON m.id = f.merchant_id
        WHERE f.order_id = ?1 AND o.user_id = ?2
        ORDER BY f.merchant_id`,
    )
      .bind(orderId, user.id, `+${RETURN_DAYS} days`)
      .all<{ merchant_id: string; seller: string; status: string; delivered_at: string | null; return_by: string | null; in_window: number }>(),
    returnRecords(env, user.id, 'rr.order_id = ?2', orderId),
  ])
  // No part of an order of this account's: not its order, or no such order.
  if (!parts.results?.length) return no(404, 'not found')
  const all = requests.results ?? []
  return ok({
    returnDays: RETURN_DAYS,
    reasons: RETURN_REASONS,
    parts: parts.results.map((f) => {
      const mineHere = all.filter((r) => r.merchant_id === f.merchant_id)
      return {
        merchantId: f.merchant_id,
        seller: f.seller,
        status: f.status,
        deliveredAt: f.delivered_at,
        returnBy: f.return_by,
        canRequest: f.in_window === 1 && !mineHere.some((r) => r.status === 'open'),
        requests: mineHere.map(returnOut),
      }
    }),
  })
}

/** A return request on one delivered part of one of the account's orders. */
export async function openReturn(env: UploadsEnv, user: User, orderId: string, body: unknown): Promise<Reply> {
  const p = fields(body)
  const merchantId = typeof p.merchantId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(p.merchantId) ? p.merchantId : null
  if (!merchantId) return no(400, 'Name the seller whose part this is.')
  if (typeof p.reason !== 'string' || !REASONS.has(p.reason)) return no(400, `reason is one of ${RETURN_REASONS.join(', ')}.`)
  const text = note(p.note, 1000)
  if (text === null) return no(400, 'A note is 1000 characters at most.')
  const part = await env.ORDERS.prepare(
    `SELECT f.status, (julianday('now') <= julianday(f.delivered_at, ?4)) AS in_window
       FROM order_fulfilments f JOIN orders o ON o.id = f.order_id
      WHERE f.order_id = ?1 AND f.merchant_id = ?2 AND o.user_id = ?3`,
  )
    .bind(orderId, merchantId, user.id, `+${RETURN_DAYS} days`)
    .first<{ status: string; in_window: number | null }>()
  if (!part) return no(404, 'not found')
  if (part.status !== 'delivered') return no(409, 'A return can be requested once this part has been delivered.')
  if (part.in_window !== 1) return no(409, `Returns can be requested within ${RETURN_DAYS} days of delivery.`)
  const returnId = id('ret')
  try {
    await env.ORDERS.prepare(`INSERT INTO return_requests (id, order_id, merchant_id, reason, note) VALUES (?1, ?2, ?3, ?4, ?5)`)
      .bind(returnId, orderId, merchantId, p.reason, text)
      .run()
  } catch (err) {
    // return_requests_open_idx: somebody (another tab) got there first.
    if (/UNIQUE/i.test(String(err))) return no(409, 'There is already an open request for this part.')
    throw err
  }
  const [row] = (await returnRecords(env, user.id, 'rr.id = ?2', returnId)).results ?? []
  return ok(returnOut(row), 201)
}

/** One more photo on one of the account's open requests: MAX_RETURN_PHOTOS at most. */
export async function addReturnPhoto(env: UploadsEnv, user: User, returnId: string, request: Request): Promise<Reply> {
  if (!env.PRIVATE) return no(503, UNAVAILABLE)
  const [own] = (await returnRecords(env, user.id, 'rr.id = ?2', returnId)).results ?? []
  if (!own) return no(404, 'not found')
  if (own.status !== 'open') return no(409, 'This request has been decided; photos can no longer be added.')
  const full = no(409, `A request has at most ${MAX_RETURN_PHOTOS} photos.`)
  if ((JSON.parse(own.photos) as string[]).length >= MAX_RETURN_PHOTOS) return full
  const read = await readWebpForm(request, [{ field: 'photo', max: MAX_LARGE_BYTES }])
  if (!Array.isArray(read)) return no(read.status, read.error)
  const name = newPhotoName()
  const key = returnKey(returnId, name)
  try {
    await env.PRIVATE.put(key, read[0], META)
    const { meta } = await env.ORDERS.prepare(
      `INSERT INTO return_photos (return_id, name)
       SELECT ?1, ?2 WHERE (SELECT COUNT(*) FROM return_photos WHERE return_id = ?1) < ?3
                       AND EXISTS (SELECT 1 FROM return_requests WHERE id = ?1 AND status = 'open')`,
    )
      .bind(returnId, name, MAX_RETURN_PHOTOS)
      .run()
    if (meta.changes !== 1) {
      await env.PRIVATE.delete(key).catch(orphaned(key))
      return full
    }
  } catch (err) {
    await env.PRIVATE.delete(key).catch(orphaned(key))
    throw err
  }
  const [row] = (await returnRecords(env, user.id, 'rr.id = ?2', returnId)).results ?? []
  return ok(returnOut(row), 201)
}

/**
 * A return photo, if `key` is one and it belongs to a request on one of the
 * account's orders; null otherwise, which the route answers 404 either way.
 */
export async function ownReturnPhoto(env: UploadsEnv, user: User, key: string): Promise<R2ObjectBody | null> {
  const parsed = isReturnKey(key)
  if (!parsed || !env.PRIVATE) return null
  const owns = await env.ORDERS.prepare(
    `SELECT 1 AS one FROM return_photos ph
       JOIN return_requests rr ON rr.id = ph.return_id
       JOIN orders o ON o.id = rr.order_id
      WHERE ph.return_id = ?1 AND ph.name = ?2 AND o.user_id = ?3`,
  )
    .bind(parsed.returnId, parsed.name, user.id)
    .first()
  return owns ? env.PRIVATE.get(key) : null
}
