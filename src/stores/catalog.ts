import { defineStore } from 'pinia'
import { products } from '@/data/products'
import { fetchCatalogue, type CatalogueProduct } from '@/lib/api'
import type { BrandId, CategoryId, Product } from '@/types'

export type Filter = 'all' | 'inStock' | CategoryId
export type Sort = 'default' | 'priceDesc' | 'priceAsc'

/**
 * Maps the live wire shape to the frontend's `Product`.
 *
 * `stockCount > 0` is the one place `inStock` gets decided from here on -
 * the API has no such column, deliberately, so nothing downstream reinvents
 * this rule. `brand`/`category`/`badge` are narrowed from the plain strings
 * D1 stores to the unions the frontend expects; the database is the trusted
 * source for those values, the same trust the build-time generator extends.
 */
function toProduct(cp: CatalogueProduct): Product {
  return {
    id: cp.id,
    sku: cp.sku,
    brand: cp.brand as BrandId,
    title: cp.title,
    category: cp.category as CategoryId,
    priceMinor: cp.priceMinor,
    currency: cp.currency,
    inStock: cp.stockCount > 0,
    stockCount: cp.stockCount,
    badge: cp.badge === null ? undefined : (cp.badge as Product['badge']),
    rating: cp.rating,
    reviewCount: cp.reviewCount,
    specsSummary: cp.specsSummary,
    specs: cp.specs,
    media: cp.media,
    colorways: cp.colorways,
  }
}

/**
 * A projection of the URL, not a source of truth.
 *
 * ShopPage mirrors `route.query` into this store and never the other way round;
 * user actions go through `router.push`. One direction means no update loop, and
 * it means every filtered view has an address someone can share or reload.
 */
export const useCatalogStore = defineStore('catalog', {
  state: () => ({
    /** The build-time snapshot, replaced in place once the API answers. */
    items: products,
    activeFilter: 'all' as Filter,
    activeBrand: null as string | null,
    dealsOnly: false,
    sort: 'default' as Sort,
  }),

  getters: {
    visible: (state) => {
      const filtered = state.items.filter((p) => {
        if (state.activeBrand && p.brand !== state.activeBrand) return false
        if (state.dealsOnly && p.badge !== 'DISCOUNT') return false
        if (state.activeFilter === 'inStock') return p.inStock
        if (state.activeFilter !== 'all') return p.category === state.activeFilter
        return true
      })

      if (state.sort === 'priceDesc') return [...filtered].sort((a, b) => b.priceMinor - a.priceMinor)
      if (state.sort === 'priceAsc') return [...filtered].sort((a, b) => a.priceMinor - b.priceMinor)
      return filtered
    },

    hasFilters: (state) =>
      state.activeFilter !== 'all' ||
      state.activeBrand !== null ||
      state.dealsOnly ||
      state.sort !== 'default',
  },

  actions: {
    /**
     * Revalidate against the live catalogue after first paint.
     *
     * A failure - offline, timeout, an empty body - leaves the snapshot in
     * place. A shop that empties itself because one request failed is worse
     * than one still showing a price from the last deploy. Order is never
     * touched here: the API already orders by display_order, and re-sorting
     * it would undo the one thing this overlay is required not to change.
     */
    async refresh() {
      const list = await fetchCatalogue()
      if (list?.length) this.items = list.map(toProduct)
    },
  },
})
