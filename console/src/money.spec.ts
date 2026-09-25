import { describe, it, expect } from 'vitest'
import { parsePriceToMinor, formatAmounts, formatMinor, groupByCurrency, seriesByCurrency } from './money'

// The one piece of real logic in the merchant/platform pages: a typed major-
// unit price string has to become an exact integer of minor units, with no
// float arithmetic that can round '0.1' or '1199.5' wrong.
describe('parsePriceToMinor', () => {
  it('converts whole and fractional prices without float rounding', () => {
    expect(parsePriceToMinor('1199')).toBe(119900)
    expect(parsePriceToMinor('1199.5')).toBe(119950)
    expect(parsePriceToMinor('1199.99')).toBe(119999)
    expect(parsePriceToMinor('0.1')).toBe(10)
  })

  it('rejects malformed input instead of guessing a number', () => {
    expect(parsePriceToMinor('')).toBeNull()
    expect(parsePriceToMinor('abc')).toBeNull()
    expect(parsePriceToMinor('-5')).toBeNull()
    expect(parsePriceToMinor('1.999')).toBeNull()
    expect(parsePriceToMinor('12.')).toBeNull()
    expect(parsePriceToMinor('1,199')).toBeNull()
    expect(parsePriceToMinor('19.99.99')).toBeNull()
  })
})

describe('formatAmounts', () => {
  it('shows each currency on its own rather than adding them', () => {
    const usd = formatMinor(2000, 'USD')
    const sgd = formatMinor(700, 'SGD')
    expect(formatAmounts([{ currency: 'USD', minor: 2000 }, { currency: 'SGD', minor: 700 }])).toBe(`${usd} · ${sgd}`)
    expect(formatAmounts([])).toBe('—')
    expect(formatAmounts([], 'No sales')).toBe('No sales')
  })
})

describe('seriesByCurrency', () => {
  it('splits a mixed trend into one full-length series per currency', () => {
    const trend = [
      { day: '2026-09-01', revenue: [{ currency: 'USD', minor: 100 }] },
      { day: '2026-09-02', revenue: [] },
      { day: '2026-09-03', revenue: [{ currency: 'SGD', minor: 7 }, { currency: 'USD', minor: 5 }] },
    ]
    expect(seriesByCurrency(trend)).toEqual([
      { currency: 'SGD', days: [{ day: '2026-09-01', minor: 0 }, { day: '2026-09-02', minor: 0 }, { day: '2026-09-03', minor: 7 }] },
      { currency: 'USD', days: [{ day: '2026-09-01', minor: 100 }, { day: '2026-09-02', minor: 0 }, { day: '2026-09-03', minor: 5 }] },
    ])
  })
})

describe('groupByCurrency', () => {
  it('ranks within each currency, never across them', () => {
    const rows = [
      { id: 'lion', currency: 'SGD', minor: 88000 },
      { id: 'apple', currency: 'USD', minor: 3120050 },
      { id: 'sony', currency: 'USD', minor: 50000 },
    ]
    expect(groupByCurrency(rows)).toEqual([
      { currency: 'SGD', rows: [rows[0]] },
      { currency: 'USD', rows: [rows[1], rows[2]] },
    ])
  })
})
