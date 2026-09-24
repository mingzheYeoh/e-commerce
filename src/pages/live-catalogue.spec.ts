import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import ProductCard from '@/components/commerce/ProductCard.vue'
import ProductPage from './ProductPage.vue'
import ShopPage from './ShopPage.vue'
import { catalogue, catalogueSettled, findProduct, refreshCatalogue } from '@/stores/catalog'
import { useCartStore } from '@/stores/cart'
import { hybridSearch } from '@/lib/semantic'
import { products } from '@/data/products'
import type { CatalogueProduct } from '@/lib/api'

/**
 * A product exactly as the merchant console publishes one: a brand typed free
 * rather than picked from the curated list, no colourways, no reviews, photos
 * on R2 at absolute URLs, and a single photo so no hover image.
 */
const PHOTO = 'https://nexus-api.example.workers.dev/media/u/m_acme/p_7f3a2c/front'
const consoleProduct: CatalogueProduct = {
  id: 'p_7f3a2c',
  merchantId: 'm_acme',
  sku: 'ACME-ST1',
  title: 'Studio One Monitor Headphones',
  brand: 'Acme Audio Co',
  category: 'audio',
  priceMinor: 12345,
  currency: 'USD',
  stockCount: 7,
  badge: null,
  rating: 0,
  reviewCount: 0,
  specs: [{ label: 'Driver', value: '40mm dynamic' }],
  specsSummary: ['40mm driver', '30-hour battery', 'USB-C'],
  colorways: [],
  media: { heroImage: `${PHOTO}-1600.webp`, thumb: `${PHOTO}-400.webp`, gallery: [`${PHOTO}-1600.webp`] },
}

const router = () =>
  createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)*', component: { template: '<div />' } }] })

async function mountWith(component: unknown, props: Record<string, unknown> = {}) {
  const r = router()
  await r.push('/shop')
  await r.isReady()
  return mount(component as never, { props: props as never, global: { plugins: [r] } })
}

const serve = (list: CatalogueProduct[]) =>
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ products: list }) }))

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => {
  catalogue.value = products
  catalogueSettled.value = false
  vi.unstubAllGlobals()
})

describe('a console-published product', () => {
  it('renders as a card without breaking on what it lacks', async () => {
    serve([consoleProduct])
    await refreshCatalogue()
    const wrapper = await mountWith(ProductCard, { product: findProduct(consoleProduct.id) })
    const text = wrapper.text()

    expect(text).toContain('Acme Audio Co')
    expect(text).toContain(consoleProduct.title)
    expect(text).toContain('$123.45')
    expect(text).toContain('40mm driver · 30-hour battery · USB-C')
    // Unreviewed: no stars and no "0.0", rather than a zero rating.
    expect(text).not.toContain('0.0')
    expect(text).not.toContain('Available in')
    expect(wrapper.find(`img[src="${PHOTO}-1600.webp"]`).exists()).toBe(true)
    expect(wrapper.find('button[aria-label^="Add "]').attributes('disabled')).toBeUndefined()
  })
})

describe('search for a product with no precomputed vector', () => {
  it('finds it by name through the keyword path, unrated or not', async () => {
    serve([consoleProduct, ...products.slice(0, 5).map(({ inStock: _, ...p }) => ({ ...p, merchantId: 'm', badge: p.badge ?? null }))])
    await refreshCatalogue()
    // Semantic is not ready here, as on a first search; the vectors cover the
    // snapshot only, so this path is the one a new product relies on.
    const { products: hits, semantic } = await hybridSearch('acme studio monitor headphones')
    expect(semantic).toBe(false)
    expect(hits[0]?.id).toBe(consoleProduct.id)
  })
})

describe('the product page for an id the snapshot does not have', () => {
  it('waits for the live catalogue instead of answering 404, then renders it', async () => {
    const pending = new Promise<unknown>(() => {})
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(pending))
    const wrapper = await mountWith(ProductPage, { id: consoleProduct.id })
    expect(wrapper.text()).toContain('Loading product')
    expect(wrapper.text()).not.toContain('404')

    serve([consoleProduct, ...products.slice(0, 3).map(({ inStock: _, ...p }) => ({ ...p, merchantId: 'm', badge: p.badge ?? null }))])
    await refreshCatalogue()
    await flushPromises()

    const text = wrapper.text()
    expect(text).toContain(consoleProduct.title)
    expect(text).toContain('Acme Audio Co')
    expect(text).toContain('$123.45')
    expect(text).toContain('40mm dynamic')
    expect(text).toContain('Only 7 left in stock')
    expect(text).not.toContain('reviews')
    // The main photo shows before the gallery probe settles.
    expect(wrapper.find(`img[src="${PHOTO}-1600.webp"]`).exists()).toBe(true)
  })

  it('answers 404 once the live catalogue has settled without it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')))
    await refreshCatalogue()
    const wrapper = await mountWith(ProductPage, { id: consoleProduct.id })
    expect(wrapper.text()).toContain('404')
  })
})

describe('one product, one price', () => {
  it('shows the live price on the shop grid, the product page and in the cart alike', async () => {
    const product = products.find((p) => p.inStock)!
    const cart = useCartStore()
    cart.add(product) // added at the snapshot price

    const { inStock: _, ...rest } = product
    serve([{ ...rest, merchantId: 'm', badge: rest.badge ?? null, priceMinor: 777 }, consoleProduct])
    await refreshCatalogue()

    const shop = await mountWith(ShopPage)
    const page = await mountWith(ProductPage, { id: product.id })
    expect(shop.text()).toContain('$7.77')
    expect(shop.text(), 'the new product is on the grid').toContain(consoleProduct.title)
    expect(page.text()).toContain('$7.77')
    expect(cart.lines[0].unitPriceCents).toBe(777)
    expect(cart.subtotalCents).toBe(777)
  })
})
