import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import StatsStrip from './StatsStrip.vue'
import { catalogue } from '@/stores/catalog'

describe('StatsStrip', () => {
  it('counts every figure from the catalogue it is showing', () => {
    // Nothing on the strip is a claim the data does not back.
    const items = catalogue.value
    const w = mount(StatsStrip)
    const figures = Object.fromEntries(
      w.findAll('dl > div').map((d) => [d.get('dt').text(), d.get('.sr-only').text()]),
    )
    expect(figures).toEqual({
      Products: String(items.length),
      Brands: String(new Set(items.map((p) => p.brand)).size),
      Categories: String(new Set(items.map((p) => p.category)).size),
      'Units in stock': items.reduce((n, p) => n + p.stockCount, 0).toLocaleString('en-US'),
    })
  })
})
