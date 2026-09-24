import { setActivePinia, createPinia } from 'pinia'
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { useCatalogStore, catalogue, catalogueSettled, findProduct, refreshCatalogue } from './catalog'
import { useCartStore } from './cart'
import { useCheckoutStore } from './checkout'
import { recommend } from '@/lib/recommend'
import { brands } from '@/data/brands'
import { products } from '@/data/products'
import type { CatalogueProduct } from '@/lib/api'
import type { Product } from '@/types'

/** A snapshot product as GET /api/products sends it. */
const wire = ({ inStock: _, ...p }: Product, patch: Partial<CatalogueProduct> = {}): CatalogueProduct => ({
  ...p,
  merchantId: 'm_nexus',
  badge: p.badge ?? null,
  ...patch,
})

const serve = (list: CatalogueProduct[]) =>
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ products: list }) }))

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => {
  catalogue.value = products
  catalogueSettled.value = false
  vi.unstubAllGlobals()
})

describe('the catalogue store', () => {
  it('renders the baked snapshot, in the order the file carries', () => {
    // The storefront is a static site that must paint without the API, and the
    // shop page renders `visible` as-is, so the file's order is behaviour.
    const store = useCatalogStore()
    expect(store.items).toHaveLength(products.length)
    expect(store.visible.map((p) => p.id)).toEqual(products.map((p) => p.id))
    expect(catalogueSettled.value).toBe(false)
  })

  it('replaces the snapshot with the live list, and every reader sees the same product', async () => {
    const [first, second] = products
    const cart = useCartStore()
    cart.add(first, 2)
    const store = useCatalogStore()

    serve([wire(first, { priceMinor: 4321, stockCount: 3 }), wire(second)])
    await refreshCatalogue()

    expect(catalogueSettled.value).toBe(true)
    expect(store.items.map((p) => p.id)).toEqual([first.id, second.id])

    // One object, one price: the grid, the product page's lookup and the bag.
    const live = findProduct(first.id)!
    expect(store.visible[0]).toBe(live)
    expect(live.priceMinor).toBe(4321)
    expect(live.inStock).toBe(true)
    expect(cart.lines[0].unitPriceCents).toBe(4321)
    expect(cart.lines[0].stockCount).toBe(3)
    expect(cart.subtotalCents).toBe(4321 * 2)
    // Helpers outside components read it too: search cannot find a product
    // the live list no longer carries, and brand counts follow the live list.
    const gone = products[5]
    expect(recommend(gone.title).items.map((r) => r.product.id)).not.toContain(gone.id)
    expect(brands.find((b) => b.id === first.brand)!.productCount).toBe(
      [first, second].filter((p) => p.brand === first.brand).length,
    )
  })

  it('does not re-sort the live catalogue', async () => {
    // The worker orders by display_order; that order is shown as-is.
    const reordered = [products[2], products[0], products[1]]
    serve(reordered.map((p) => wire(p)))
    await refreshCatalogue()
    expect(useCatalogStore().visible.map((p) => p.id)).toEqual(reordered.map((p) => p.id))
  })

  it('keeps the snapshot when the API is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')))
    await refreshCatalogue()
    // A failed revalidation must not empty the shop - but it has settled, so a
    // product page for an unknown id can stop waiting and say 404.
    expect(useCatalogStore().items).toBe(products)
    expect(catalogueSettled.value).toBe(true)
  })

  it('keeps the snapshot on an error status or an empty list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }))
    await refreshCatalogue()
    expect(catalogue.value).toBe(products)

    serve([])
    await refreshCatalogue()
    expect(catalogue.value).toBe(products)
  })
})

describe('a product that leaves the live catalogue', () => {
  it('leaves the grid, and its cart line becomes unavailable and uncheckoutable', async () => {
    const [kept, dropped] = products.filter((p) => p.inStock)
    const cart = useCartStore()
    cart.add(kept)
    cart.add(dropped)
    expect(cart.hasUnavailable, 'before the fetch, nothing is presumed gone').toBe(false)

    serve([wire(kept)])
    await refreshCatalogue()

    expect(useCatalogStore().visible.map((p) => p.id)).toEqual([kept.id])
    const line = cart.lines.find((l) => l.productId === dropped.id)!
    expect(line.available).toBe(false)
    expect(cart.hasUnavailable).toBe(true)
    // Still in the bag so the shopper sees what happened, but not owed.
    expect(cart.items).toHaveLength(2)
    expect(cart.subtotalCents).toBe(kept.priceMinor)

    const checkout = useCheckoutStore()
    Object.assign(checkout.address, {
      name: 'Ada', email: 'ada@example.com', country: 'US', line1: '1 Main St',
      city: 'Portland', state: 'OR', postal: '97201',
    })
    checkout.card.number = '4242 4242 4242 4242'
    expect(await checkout.place()).toEqual({ ok: false })
    expect(checkout.error).toMatch(/no longer available/)
    expect(cart.items, 'a refusal keeps the bag').toHaveLength(2)

    cart.remove(dropped.id)
    expect(cart.hasUnavailable).toBe(false)
  })

  it('marks a sold-out product unavailable too', async () => {
    const product = products.find((p) => p.inStock)!
    const cart = useCartStore()
    cart.add(product)
    serve([wire(product, { stockCount: 0 })])
    await refreshCatalogue()
    expect(cart.lines[0].available).toBe(false)
  })
})
