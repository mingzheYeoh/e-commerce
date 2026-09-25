/**
 * The storefront's read of the catalogue.
 *
 * This deliberately does NOT go through tenancy.ts. That module's two doors —
 * scopedTo and platformWide — are both for staff, gated by a merchant id or a
 * platform pass. A shopper holds neither: they are not a merchant staffer
 * viewing their own listings, and a published product is public by
 * definition, not platform-staff business.
 *
 * Routing this through platformWide would write one audit_log row per
 * storefront visitor — that table is for staff activity, not page views — and
 * adding a third door here would break the "only two ways in" property the
 * tenancy core is built to guarantee. Someone will eventually want to "fix"
 * this into scopedTo/platformWide for consistency; that is exactly the change
 * this comment exists to stop. If the catalogue read ever needs the same
 * audit trail, that is a reason to change tenancy.ts's rules, not to route a
 * public GET through a staff-only door.
 */
import type { PassageSource } from '../../src/lib/passages'

export interface CatalogueProduct {
  id: string
  merchantId: string
  sku: string
  title: string
  brand: string
  category: string
  priceMinor: number
  currency: string
  stockCount: number
  badge: string | null
  rating: number
  reviewCount: number
  specs: { label: string; value: string }[]
  specsSummary: string[]
  colorways: { name: string; hex: string }[]
  media: Record<string, unknown>
}

interface Row {
  id: string
  merchant_id: string
  sku: string
  title: string
  brand: string
  category: string
  price_minor: number
  currency: string
  stock_count: number
  badge: string | null
  rating: number
  review_count: number
  specs: string
  specs_summary: string
  colorways: string
  media: string
}

/** JSON columns are stored as text; a bad row must not take the page down. */
const parse = <T>(text: string, fallback: T): T => {
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

export async function publishedProducts(env: { ORDERS: D1Database }): Promise<CatalogueProduct[]> {
  const { results } = await env.ORDERS.prepare(
    // display_order first. 0008 seeded every row in one batch, so they all
    // share a created_at and ordering by that alone hands back the catalogue
    // alphabetically by id - a visibly different shop page. See
    // migrations/0010-display-order.sql.
    //
    // Joined to merchants because a suspended merchant's products leave the
    // storefront (schema.sql, on merchants.status). p.* rather than *: the
    // join would otherwise bring merchants.id and friends into every row.
    `SELECT p.* FROM products p JOIN merchants m ON m.id = p.merchant_id
      WHERE p.status = 'published' AND m.status = 'active'
      ORDER BY p.display_order, p.created_at DESC, p.id`,
  ).all<Row>()

  return (results ?? []).map((r) => ({
    id: r.id,
    merchantId: r.merchant_id,
    sku: r.sku,
    title: r.title,
    brand: r.brand,
    category: r.category,
    priceMinor: r.price_minor,
    currency: r.currency,
    stockCount: r.stock_count,
    badge: r.badge,
    rating: r.rating,
    reviewCount: r.review_count,
    specs: parse(r.specs, []),
    specsSummary: parse(r.specs_summary, []),
    colorways: parse(r.colorways, []),
    media: parse(r.media, {}),
  }))
}

/* ------------------------------------------------ what the AI layers may name */

/**
 * Published, and sold by a merchant who is active.
 *
 * The Vectorize index and the graph are copies of this table, made at other
 * moments, so every AI read is checked against it at query time (rag.ts,
 * tools.ts). That is what makes an unpublish or a suspension take effect on
 * the very next question with no hook in the routes that change status, and
 * what makes an index delete that failed cost a filtered hit rather than a
 * product the shop no longer sells showing up in an answer.
 */
const LIVE = `FROM products p JOIN merchants m ON m.id = p.merchant_id
  WHERE p.status = 'published' AND m.status = 'active'`

/** Which of these ids are live right now. One query however many there are. */
export async function liveIds(env: { ORDERS: D1Database }, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set()
  const { results } = await env.ORDERS.prepare(
    // One JSON binding rather than a placeholder per id, so a large topK never
    // meets D1's cap on bound parameters.
    `SELECT p.id ${LIVE} AND p.id IN (SELECT value FROM json_each(?1))`,
  )
    .bind(JSON.stringify(ids))
    .all<{ id: string }>()
  return new Set((results ?? []).map((r) => r.id))
}

/**
 * A products row as the passage builder and fact extractor read it: the same
 * mapping as scripts/build-catalog.mjs `toProduct`, so a product indexed at
 * publish time gets byte-for-byte the passage the offline builder would write.
 */
export const productOf = (
  r: Pick<Row, 'id' | 'title' | 'brand' | 'category' | 'price_minor' | 'specs_summary' | 'specs'>,
): PassageSource & { id: string } => ({
  id: r.id,
  title: r.title,
  brand: r.brand,
  // The console accepts only the storefront's categories; the same trust the
  // build-time generator and the storefront's own mapping extend.
  category: r.category as PassageSource['category'],
  priceMinor: r.price_minor,
  specsSummary: parse(r.specs_summary, []),
  specs: parse(r.specs, []),
})

// ponytail: every tool call reads the whole live catalogue. Fine for hundreds
// of products; a name index (FTS5) and per-fact columns when it is thousands.
export async function liveProducts(env: { ORDERS: D1Database }) {
  const { results } = await env.ORDERS.prepare(
    `SELECT p.* ${LIVE} ORDER BY p.display_order, p.created_at DESC, p.id`,
  ).all<Row>()
  return (results ?? []).map(productOf)
}
