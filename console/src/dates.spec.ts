import { describe, it, expect } from 'vitest'
import { buckets, monthRange, presetRange } from './dates'

const NOW = Date.parse('2026-03-15T23:30:00Z')

describe('report ranges', () => {
  it('counts today as the last day of every preset, in UTC', () => {
    expect(presetRange('7', NOW)).toEqual({ from: '2026-03-09', to: '2026-03-15' })
    expect(presetRange('30', NOW)).toEqual({ from: '2026-02-14', to: '2026-03-15' })
    expect(presetRange('month', NOW)).toEqual({ from: '2026-03-01', to: '2026-03-15' })
    expect(presetRange('last-month', NOW)).toEqual({ from: '2026-02-01', to: '2026-02-28' })
    expect(presetRange('last-month', Date.parse('2026-01-02T00:00:00Z'))).toEqual({ from: '2025-12-01', to: '2025-12-31' })
  })

  it('knows the length of every month, leap years included', () => {
    expect(monthRange('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' })
    expect(monthRange('2026-12')).toEqual({ from: '2026-12-01', to: '2026-12-31' })
  })

  it('lays out every bucket of a range, the empty ones too', () => {
    expect(buckets('2026-03-01', '2026-03-03', 1)).toEqual(['2026-03-01', '2026-03-02', '2026-03-03'])
    expect(buckets('2026-03-01', '2026-03-20', 7)).toEqual(['2026-03-01', '2026-03-08', '2026-03-15'])
  })
})
