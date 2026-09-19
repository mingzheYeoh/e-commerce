import { computed } from 'vue'
import { useUiStore, type CurrencyCode } from '@/stores/ui'

/**
 * Fixed rates, mid-market as at 2026-09-17. A storefront this size does not
 * need a live FX feed, and a hardcoded table cannot fail at runtime or leak a
 * key. Typed against `CurrencyCode` so adding a currency without its rate and
 * symbol is a compile error rather than a `NaN` on a price tag.
 */
const RATES: Record<CurrencyCode, number> = {
  USD: 1,
  EUR: 0.92,
  GBP: 0.79,
  SGD: 1.27,
  MYR: 4.1,
}

const SYMBOLS: Record<CurrencyCode, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  SGD: 'S$',
  MYR: 'RM',
}

export function useCurrency() {
  const ui = useUiStore()

  /** Cents in USD -> display string in the active currency. */
  const format = (cents: number): string => {
    const converted = (cents / 100) * RATES[ui.currency]
    return (
      SYMBOLS[ui.currency] +
      converted.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    )
  }

  /** Dollars in USD -> display string. Convenience for fixture prices. */
  const formatPrice = (price: number): string => format(Math.round(price * 100))

  return { format, formatPrice, code: computed(() => ui.currency), symbol: computed(() => SYMBOLS[ui.currency]) }
}
