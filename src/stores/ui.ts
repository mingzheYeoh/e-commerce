import { defineStore } from 'pinia'
import type { Product } from '@/types'

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

/**
 * The shopper's currency, kept in this browser so a page reload does not put
 * every price back in USD. A per-viewer convenience: storage can be blocked,
 * and then the site simply starts in USD.
 */
const CURRENCY_KEY = 'nexus:currency'
const storedCurrency = (): CurrencyCode => {
  try {
    const v = localStorage.getItem(CURRENCY_KEY)
    return isCurrencyCode(v) ? v : 'USD'
  } catch {
    return 'USD'
  }
}

export const useUiStore = defineStore('ui', {
  state: () => ({
    currency: storedCurrency(),
    searchOpen: false,
    /** Brand id whose hover portal is showing, or null. */
    activeBrand: null as string | null,
    /**
     * What a signed-out shopper tried to put in the bag. SignInPrompt asks them
     * to sign in, and adds it the moment they do.
     */
    signInFor: null as { product: Product; qty: number; finish?: string } | null,
    /** Set on signing in: WelcomeTransition greets them and takes them to `to`. */
    welcome: null as { message: string; to: string } | null,
  }),

  actions: {
    setCurrency(code: CurrencyCode) {
      // Keep the last good currency rather than adopt a bad one: a wrong
      // symbol is recoverable, NaN on every price tag is not.
      if (!isCurrencyCode(code)) return
      this.currency = code
      try {
        localStorage.setItem(CURRENCY_KEY, code)
      } catch {
        /* blocked storage: the choice lasts until the page reloads */
      }
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
