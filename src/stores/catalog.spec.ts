import { setActivePinia, createPinia } from 'pinia'
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { useCatalogStore, catalogue, catalogueStatus, findProduct, refreshCatalogue } from './catalog'
import { useCompareStore } from './compare'
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
  catalogueStatus.value = 'pending'
  vi.unstubAllGlobals()
})

describe('the catalogue store', () => {
  it('renders the baked snapshot, in the order the file carries', () => {
    // The storefront is a static site that must paint without the API, and the
    // shop page renders `visible` as-is, so the file's order is behaviour.
    const store = useCatalogStore()
    expect(store.items).toHaveLength(products.length)
    expect(store.visible.map((p) => p.id)).toEqual(products.map((p) => p.id))
    expect(catalogueStatus.value).toBe('pending')
  })

  it('replaces the snapshot with the live list, and every reader sees the same product', async () => {
    const [first, second] = products
    const cart = useCartStore()
    cart.add(first, 2)
    const store = useCatalogStore()

    serve([wire(first, { priceMinor: 4321, stockCount: 3 }), wire(second)])
    await refreshCatalogue()

    expect(catalogueStatus.value).toBe('live')
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
    // A failed revalidation must not empty the shop, and proves nothing about
    // ids the snapshot lacks - 'failed', not 'live', so nothing is dropped.
    expect(useCatalogStore().items).toBe(products)
    expect(catalogueStatus.value).toBe('failed')
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
    Object.assign(checkout.card, { number: '4242 4242 4242 4242', expiry: '12/49', cvc: '123' })
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

const readyCheckout = () => {
  const checkout = useCheckoutStore()
  Object.assign(checkout.address, {
    name: 'Ada', email: 'ada@example.com', country: 'US', line1: '1 Main St',
    city: 'Portland', state: 'OR', postal: '97201',
  })
  // A card that passes every check, expiry and CVC included, so only the catalogue decides.
  Object.assign(checkout.card, { number: '4242 4242 4242 4242', expiry: '12/49', cvc: '123' })
  return checkout
}

describe('a cart holding more than the live stock', () => {
  it('clamps the line, and the bag, subtotal and posted order all agree', async () => {
    const product = products.find((p) => p.inStock && p.stockCount >= 5)!
    const cart = useCartStore()
    cart.add(product, 5)
    serve([wire(product, { stockCount: 2 })])
    await refreshCatalogue()

    const [line] = cart.lines
    expect(line.qty).toBe(2)
    expect(line.limited).toBe(true)
    expect(line.available).toBe(true)
    expect(cart.count).toBe(2)
    expect(cart.subtotalCents).toBe(product.priceMinor * 2)

    const checkout = readyCheckout()
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)
    const result = await checkout.place()
    expect(result.ok).toBe(true)
    expect(checkout.orders[0].lines[0].qty).toBe(2)
    expect(checkout.orders[0].totals.subtotal).toBe(product.priceMinor * 2)
    const posted = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(posted.lines).toEqual([{ productId: product.id, qty: 2 }])
  })
})

describe('checkout while the live fetch is in flight', () => {
  it('waits for the live list, and so refuses a product it no longer carries', async () => {
    const [kept, dropped] = products.filter((p) => p.inStock)
    const cart = useCartStore()
    cart.add(dropped)
    let answer: (v: unknown) => void = () => {}
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise((r) => (answer = r))))
    void refreshCatalogue()

    const placing = readyCheckout().place()
    answer({ ok: true, json: async () => ({ products: [wire(kept)] }) })
    expect(await placing).toEqual({ ok: false })
    expect(useCheckoutStore().error).toMatch(/no longer available/)
  })
})

describe('checkout when the live list moves a price during the wait', () => {
  it('refuses, so the shopper reviews the new total instead of paying one they never saw', async () => {
    const product = products.find((p) => p.inStock)!
    const cart = useCartStore()
    cart.add(product)
    let answer: (v: unknown) => void = () => {}
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise((r) => (answer = r))))
    void refreshCatalogue()

    const checkout = readyCheckout()
    const placing = checkout.place()
    answer({ ok: true, json: async () => ({ products: [wire(product, { priceMinor: product.priceMinor + 5000 })] }) })
    expect(await placing).toEqual({ ok: false })
    expect(checkout.error).toMatch(/Prices were updated/)
    expect(checkout.placing).toBe(false)

    // Pressing Pay again, now looking at the new total, goes through.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }))
    expect((await checkout.place()).ok).toBe(true)
  })
})

describe('a live list with a row the storefront cannot render', () => {
  it('drops that row alone, and never leaves checkout waiting on a refresh that threw', async () => {
    const [good] = products
    serve([wire(good), { ...wire(products[1]), media: null } as unknown as CatalogueProduct])
    expect(await refreshCatalogue()).toBe(true)
    expect(catalogueStatus.value).toBe('live')
    expect(catalogue.value.map((p) => p.id)).toEqual([good.id])
  })

  it("settles as failed, not pending forever, when nothing in the list is usable", async () => {
    serve([{ ...wire(products[0]), media: null } as unknown as CatalogueProduct])
    expect(await refreshCatalogue()).toBe(false)
    expect(catalogueStatus.value).toBe('failed')
  })
})

describe('a failed fetch', () => {
  it('drops nothing it cannot vouch for: cart lines stay orderable, compare ids stay', async () => {
    localStorage.clear()
    const cart = useCartStore()
    cart.items.push({
      productId: 'published-yesterday', sku: 'NEW-1', title: 'New thing', brand: 'Acme',
      thumb: '', unitPriceCents: 1000, qty: 1, stockCount: 3,
    })
    const compare = useCompareStore()
    compare.setFromIds([products[0].id, 'published-yesterday'])

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')))
    expect(await refreshCatalogue()).toBe(false)

    expect(cart.lines[0].available).toBe(true)
    compare.setFromIds(compare.ids)
    expect(compare.ids).toContain('published-yesterday')
  })
})
