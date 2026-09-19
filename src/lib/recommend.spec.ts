import { describe, it, expect } from 'vitest'
import { recommend } from './recommend'

describe('recommend', () => {
  it('returns nothing for an empty query', () => {
    expect(recommend('').items).toHaveLength(0)
  })

  it('reads a budget out of the sentence', () => {
    expect(recommend('headphones under 300').budget?.value).toBe(300)
    expect(recommend('a camera below $2,000').budget?.value).toBe(2000)
  })

  it('keeps every result inside a stated budget, not just the first', () => {
    // Asserting only on items[0] is not enough: the top hit can land inside the
    // budget by luck while the rest of the list ignores it entirely. This has to
    // fail if the over-budget penalty is ever removed.
    const { items } = recommend('wireless earbuds under $200')
    expect(items.length).toBeGreaterThan(0)
    for (const item of items) {
      expect(item.product.price).toBeLessThanOrEqual(200)
    }
  })

  it('pushes far-over-budget products out of the results entirely', () => {
    const { items } = recommend('headphones under 200')
    expect(items.some((i) => i.product.price > 1000)).toBe(false)
  })

  it('maps a situation to the right category without naming it', () => {
    // "noisy flight" names no product type at all.
    const { items } = recommend('something for a long noisy flight')
    expect(items[0].product.category).toBe('audio')
  })

  it('honours an explicit brand', () => {
    const { items } = recommend('a laptop from Razer')
    expect(items[0].product.brand).toBe('RAZER')
  })

  it('routes a filming question to imaging', () => {
    const { items } = recommend('I want to shoot 4k video outdoors')
    expect(items[0].product.category).toBe('imaging')
  })

  it('reports what it understood', () => {
    const understood = recommend('best gaming mouse under 200').understood.join(' ')
    expect(understood).toMatch(/gaming/)
    expect(understood).toMatch(/\$200/)
    expect(understood).toMatch(/peripherals/)
  })

  it('says it understood nothing rather than inventing intent', () => {
    expect(recommend('xyzzy plugh').understood).toHaveLength(0)
  })

  it('ranks in-stock products above sold-out ones', () => {
    const { items } = recommend('earbuds')
    const soldOut = items.findIndex((i) => !i.product.inStock)
    expect(soldOut === -1 || soldOut === items.length - 1).toBe(true)
  })
})

  it('routes phone words to the phones department, not computing', () => {
    // 'phone' lived in CATEGORY_WORDS.computing before phones became its own
    // category. Nothing failed when it was left there: build, typecheck and
    // every other test stayed green while search quietly answered the wrong
    // department. This is the test that notices.
    for (const q of ['I need a new phone', 'best smartphone for photos', 'a handset under $1000']) {
      const { items } = recommend(q)
      expect(items[0].product.category).toBe('phones')
    }
  })

  it('surfaces each phone brand by name', () => {
    for (const [query, brand] of [
      ['google pixel', 'GOOGLE'],
      ['oneplus phone', 'ONEPLUS'],
      ['xiaomi phone', 'XIAOMI'],
    ] as const) {
      expect(recommend(query).items[0].product.brand).toBe(brand)
    }
  })
