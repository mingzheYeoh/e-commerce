import { computed, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import { products as snapshot } from '@/data/products'
import { fetchCatalogue, type CatalogueProduct } from '@/lib/api'
import type { CategoryId, Product } from '@/types'

export type Filter = 'all' | 'inStock' | CategoryId
export type Sort = 'default' | 'priceDesc' | 'priceAsc'

/* ------------------------------------------------------------- the catalogue */

/**
 * THE catalogue. Every page, store and helper that shows or prices a product
 * reads it from here; nothing else takes products from `@/data/products`
 * (HeroViewport takes only the curated pick's identity from it).
 *
 * That is the whole point of this module. The overlay removed in 0922443 made
 * the shop grid live while the product page, cart, compare and search kept
 * reading the build-time file, so one product could carry two prices depending
 * on the page. Uniformly one-deploy-old was coherent; half-live was not. Live is
 * coherent again only if there is exactly one list and everything reads it.
 *
 * Seeded with the build-time snapshot so the first paint needs no network, then
 * replaced once per page load by `refreshCatalogue()`. A module-level ref rather
 * than store state so plain functions (recommend, semantic, brand counts) can
 * read it without an active Pinia; the store below exposes it as `items`.
 */
export const catalogue = shallowRef<Product[]>(snapshot)

/**
 * Where the list came from.
 *
 * - `pending`: still the snapshot, fetch in flight. An id the snapshot lacks
 *   may be newer than the build, so nothing unknown is treated as gone yet.
 * - `live`: the API answered. An unknown id really is unpublished.
 * - `failed`: still the snapshot, and it will stay so for this page load. An
 *   unknown id is unknowable, not gone: nothing is dropped or 404ed on its
 *   account.
 */
export type CatalogueStatus = 'pending' | 'live' | 'failed'
export const catalogueStatus = shallowRef<CatalogueStatus>('pending')

const byId = computed(() => new Map(catalogue.value.map((p) => [p.id, p])))

/** The live product for an id, or undefined if it is not published. */
export const findProduct = (id: string): Product | undefined => byId.value.get(id)

/**
 * Maps the live wire shape to the frontend's `Product`.
 *
 * `stockCount > 0` is the one place `inStock` gets decided at runtime - the API
 * has no such column, deliberately. `category`/`badge` are narrowed from the
 * plain strings D1 stores; the console only accepts the storefront's categories,
 * the same trust the build-time generator extends.
 */
function toProduct(cp: CatalogueProduct): Product {
  return {
    id: cp.id,
    sku: cp.sku,
    brand: cp.brand,
    title: cp.title,
    category: cp.category as CategoryId,
    priceMinor: cp.priceMinor,
    currency: cp.currency,
    inStock: cp.stockCount > 0,
    stockCount: cp.stockCount,
    badge: cp.badge === null ? undefined : (cp.badge as Product['badge']),
    rating: cp.rating,
    reviewCount: cp.reviewCount,
    specsSummary: cp.specsSummary ?? [],
    specs: cp.specs ?? [],
    media: { ...cp.media, gallery: cp.media.gallery ?? [] },
    colorways: cp.colorways ?? [],
  }
}

let refreshing: Promise<boolean> | null = null

/**
 * Replaces the snapshot with the live catalogue, and says whether it did.
 * Called once, from main.ts, after mount - so it never blocks first paint and
 * it is one GET per page load, not one per component.
 *
 * A failure - offline, timeout, an empty body - leaves the snapshot in place. A
 * shop that empties itself because one request failed is worse than one still
 * showing a price from the last deploy. Order is never touched: the API already
 * orders by display_order.
 */
export function refreshCatalogue(): Promise<boolean> {
  refreshing = (async () => {
    const list = await fetchCatalogue()
    const live = Boolean(list?.length)
    if (live) catalogue.value = list!.map(toProduct)
    catalogueStatus.value = live ? 'live' : 'failed'
    return live
  })()
  return refreshing
}

/**
 * Resolves once the page load's fetch has settled (at once if none started).
 * Checkout awaits it so an order is never placed against the snapshot while
 * the live list is a moment away.
 */
export const catalogueReady = (): Promise<unknown> => refreshing ?? Promise.resolve()

/* ---------------------------------------------------------------- the store */

/**
 * A projection of the URL, not a source of truth.
 *
 * ShopPage mirrors `route.query` into this store and never the other way round;
 * user actions go through `router.push`. One direction means no update loop, and
 * it means every filtered view has an address someone can share or reload.
 */
export const useCatalogStore = defineStore('catalog', {
  state: () => ({
    activeFilter: 'all' as Filter,
    activeBrand: null as string | null,
    dealsOnly: false,
    sort: 'default' as Sort,
  }),

  getters: {
    /** The live catalogue - see `catalogue` above. */
    items: (): Product[] => catalogue.value,

    visible(state): Product[] {
      const filtered = this.items.filter((p) => {
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
})
