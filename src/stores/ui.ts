import { defineStore } from 'pinia'

export type CurrencyCode = 'USD' | 'EUR' | 'GBP' | 'SGD' | 'MYR'

/**
 * The codes that actually have a rate and a symbol.
 *
 * `setCurrency` is called from a `<select>` whose handler casts with
 * `as CurrencyCode` — a promise to the compiler that nothing enforces at
 * runtime. An unrecognised code is not a type error, it is every price on the
 * site rendering "undefinedNaN", silently and site-wide.
 */
const SUPPORTED: readonly CurrencyCode[] = ['USD', 'EUR', 'GBP', 'SGD', 'MYR']

export const isCurrencyCode = (v: unknown): v is CurrencyCode =>
  typeof v === 'string' && (SUPPORTED as readonly string[]).includes(v)

export const useUiStore = defineStore('ui', {
  state: () => ({
    currency: 'USD' as CurrencyCode,
    searchOpen: false,
    /** Brand id whose hover portal is showing, or null. */
    activeBrand: null as string | null,
  }),

  actions: {
    setCurrency(code: CurrencyCode) {
      // Keep the last good currency rather than adopt a bad one: a wrong
      // symbol is recoverable, NaN on every price tag is not.
      if (isCurrencyCode(code)) this.currency = code
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
