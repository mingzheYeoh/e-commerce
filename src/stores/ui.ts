import { defineStore } from 'pinia'

export type CurrencyCode = 'USD' | 'EUR' | 'GBP'

export const useUiStore = defineStore('ui', {
  state: () => ({
    currency: 'USD' as CurrencyCode,
    searchOpen: false,
    /** Brand id whose hover portal is showing, or null. */
    activeBrand: null as string | null,
  }),

  actions: {
    setCurrency(code: CurrencyCode) {
      this.currency = code
    },
    openSearch() {
      this.searchOpen = true
    },
    closeSearch() {
      this.searchOpen = false
    },
    toggleSearch() {
      this.searchOpen = !this.searchOpen
    },
  },
})
