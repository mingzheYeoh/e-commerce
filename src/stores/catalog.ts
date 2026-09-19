import { defineStore } from 'pinia'
import { products } from '@/data/products'
import type { CategoryId } from '@/types'

export type Filter = 'all' | 'inStock' | CategoryId
export type Sort = 'default' | 'priceDesc'

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
    sort: 'default' as Sort,
  }),

  getters: {
    visible: (state) => {
      const filtered = products.filter((p) => {
        if (state.activeBrand && p.brand !== state.activeBrand) return false
        if (state.activeFilter === 'inStock') return p.inStock
        if (state.activeFilter !== 'all') return p.category === state.activeFilter
        return true
      })

      return state.sort === 'priceDesc'
        ? [...filtered].sort((a, b) => b.price - a.price)
        : filtered
    },

    hasFilters: (state) =>
      state.activeFilter !== 'all' || state.activeBrand !== null || state.sort !== 'default',
  },
})
