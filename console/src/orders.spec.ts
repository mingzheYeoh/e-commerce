import { describe, it, expect } from 'vitest'
import { rate, shipTime } from './orders'

describe('the platform pages’ ratios', () => {
  it('shows ship time in hours under two days and days past that, and a dash when nothing shipped', () => {
    expect(shipTime(null)).toBe('—')
    expect(shipTime(5400)).toBe('1.5 h')
    expect(shipTime(86_400)).toBe('24.0 h')
    expect(shipTime(3 * 86_400)).toBe('3.0 d')
  })

  it('divides only when there is something to divide by', () => {
    expect(rate(1, 4)).toBe('25.0%')
    expect(rate(0, 0)).toBe('—')
  })
})
