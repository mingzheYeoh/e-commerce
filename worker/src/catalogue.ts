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
    `SELECT * FROM products WHERE status = 'published' ORDER BY display_order, created_at DESC, id`,
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
