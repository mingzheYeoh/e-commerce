import { describe, it, expect } from 'vitest'
import { parsePriceToMinor } from './money'

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
