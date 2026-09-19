import { defineStore } from 'pinia'
import { products } from '@/data/products'
import type { CategoryId } from '@/types'

export type Filter = 'all' | 'inStock' | CategoryId
export type Sort = 'default' | 'priceDesc'

export const useCatalogStore = defineStore('catalog', {
  state: () => ({
    activeFilter: 'all' as Filter,
    sort: 'default' as Sort,
  }),

  getters: {
    visible: (state) => {
      const filtered = products.filter((p) => {
        if (state.activeFilter === 'all') return true
        if (state.activeFilter === 'inStock') return p.inStock
        return p.category === state.activeFilter
      })

      return state.sort === 'priceDesc'
        ? [...filtered].sort((a, b) => b.price - a.price)
        : filtered
    },
  },

  actions: {
    setFilter(filter: Filter) {
      this.activeFilter = filter
    },
    setSort(sort: Sort) {
      this.sort = sort
    },
  },
})
