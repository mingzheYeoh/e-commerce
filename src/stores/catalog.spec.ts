import { setActivePinia, createPinia } from 'pinia'
import { beforeEach, describe, it, expect, vi } from 'vitest'
import { useCatalogStore } from './catalog'
import { products } from '@/data/products'

describe('the catalogue store', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('renders the baked snapshot before any fetch', () => {
    // The storefront is a static site that must paint without the API.
    expect(useCatalogStore().items).toHaveLength(products.length)
  })

  it('replaces the snapshot once the live catalogue arrives', async () => {
    const store = useCatalogStore()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ products: [{ ...products[0], priceMinor: 1 }] }),
    }))
    await store.refresh()
    expect(store.items).toHaveLength(1)
    expect(store.items[0].priceMinor).toBe(1)
  })

  it('keeps the snapshot when the API is unreachable', async () => {
    const store = useCatalogStore()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await store.refresh()
    // A failed revalidation must not empty the shop.
    expect(store.items).toHaveLength(products.length)
  })

  it('does not re-sort the live catalogue', async () => {
    // The worker orders by display_order; the overlay must reflect that order
    // as-is, not run it back through the store's own sort.
    const store = useCatalogStore()
    const reordered = [products[2], products[0], products[1]].map((p) => ({ ...p }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ products: reordered }),
    }))
    await store.refresh()
    expect(store.items.map((p) => p.id)).toEqual(reordered.map((p) => p.id))
  })
})
