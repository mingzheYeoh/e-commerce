import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useCurrency } from './useCurrency'
import { useUiStore, type CurrencyCode } from '@/stores/ui'

describe('useCurrency', () => {
  beforeEach(() => setActivePinia(createPinia()))

  const at = (code: CurrencyCode) => {
    useUiStore().setCurrency(code)
    return useCurrency()
  }

  it('converts and labels each supported currency', () => {
    expect(at('USD').formatPrice(1199)).toBe('$1,199.00')
    expect(at('EUR').formatPrice(1199)).toBe('€1,103.08')
    expect(at('GBP').formatPrice(1199)).toBe('£947.21')
    expect(at('SGD').formatPrice(1199)).toBe('S$1,522.73')
    expect(at('MYR').formatPrice(1199)).toBe('RM4,915.90')
  })

  it('never renders NaN for any currency the picker offers', () => {
    // The Record<CurrencyCode, ...> tables make a missing rate a compile error,
    // but that only holds while the tables stay typed. This asserts the
    // user-visible consequence: a price tag must never read "$NaN".
    for (const code of ['USD', 'EUR', 'GBP', 'SGD', 'MYR'] as CurrencyCode[]) {
      const out = at(code).formatPrice(899.99)
      expect(out).not.toMatch(/NaN|undefined/)
      expect(out).toMatch(/\d/)
    }
  })

  it('formats from integer cents without floating-point drift', () => {
    // 899.95 x 3 is 2699.8500000000004 in floats. The cart totals in cents for
    // exactly this reason, and the formatter must not undo it.
    const { format } = at('USD')
    expect(format(89995 * 3)).toBe('$2,699.85')
  })

  it('keeps two decimal places on a round number', () => {
    expect(at('USD').formatPrice(1200)).toBe('$1,200.00')
  })
})
