import { describe, it, expect, beforeEach } from 'vitest'
import {
  groupResults,
  flatten,
  matchCategories,
  matchBrands,
  rowTarget,
  step,
  popular,
  readRecent,
  pushRecent,
  clearRecent,
  RECENT_KEY,
} from './palette'
import type { Brand, Category, Product } from '@/types'

const product = (id: string, reviewCount = 0) => ({ id, reviewCount }) as Product
const category = (id: string, label: string) => ({ id, label }) as Category
const brand = (id: string, name: string) => ({ id, name }) as Brand

const CATEGORIES = [
  category('audio', 'Audio & headphones'),
  category('imaging', 'Cameras & drones'),
  category('phones', 'Phones'),
]
const BRANDS = [brand('SONY', 'Sony'), brand('DJI', 'DJI'), brand('APPLE', 'Apple')]

describe('matching categories and brands', () => {
  it('matches a category by a word in its label, singular or plural', () => {
    expect(matchCategories('camera', CATEGORIES).map((c) => c.id)).toEqual(['imaging'])
    expect(matchCategories('headphones for a flight', CATEGORIES).map((c) => c.id)).toEqual([
      'audio',
    ])
  })

  it('matches a brand while it is still being typed', () => {
    expect(matchBrands('so', BRANDS).map((b) => b.id)).toEqual(['SONY'])
    expect(matchBrands('dji mini', BRANDS).map((b) => b.id)).toEqual(['DJI'])
  })

  it('matches nothing for an empty query or single letters', () => {
    expect(matchCategories('', CATEGORIES)).toEqual([])
    expect(matchBrands('a', BRANDS)).toEqual([])
  })

  it('does not match "phones" inside "headphones"', () => {
    expect(matchCategories('phones', CATEGORIES).map((c) => c.id)).toEqual(['phones'])
  })
})

describe('grouping results', () => {
  const rows = [
    { product: product('p1'), reasons: [] },
    { product: product('p2'), reasons: ['under $500'] },
  ]

  it('orders groups Products, Categories, Brands, then Ask AI', () => {
    const groups = groupResults('sony camera', rows, CATEGORIES, BRANDS)
    expect(groups.map((g) => g.label)).toEqual(['Products', 'Categories', 'Brands', 'Ask AI'])
  })

  it('drops empty groups but always offers Ask AI for a query', () => {
    const groups = groupResults('zzz', [], CATEGORIES, BRANDS)
    expect(groups.map((g) => g.label)).toEqual(['Ask AI'])
    expect(groups[0].rows).toEqual([{ kind: 'ask', query: 'zzz' }])
  })

  it('offers no Ask AI row for a blank query', () => {
    expect(groupResults('  ', rows, CATEGORIES, BRANDS).map((g) => g.label)).toEqual(['Products'])
  })

  it('numbers rows across groups so arrow keys walk them in display order', () => {
    const groups = groupResults('sony camera', rows, CATEGORIES, BRANDS)
    expect(groups.map((g) => g.start)).toEqual([0, 2, 3, 4])
    expect(flatten(groups).map((r) => r.kind)).toEqual([
      'product',
      'product',
      'category',
      'brand',
      'ask',
    ])
  })

  it('carries the trimmed query into the Ask AI row', () => {
    const last = flatten(groupResults('  best mouse ', [], [], []))
    expect(last).toEqual([{ kind: 'ask', query: 'best mouse' }])
  })
})

describe('where a row goes', () => {
  it('routes each kind of row', () => {
    expect(rowTarget({ kind: 'product', product: product('p1'), reasons: [] })).toBe('/product/p1')
    expect(rowTarget({ kind: 'category', category: CATEGORIES[0] })).toBe('/shop?category=audio')
    expect(rowTarget({ kind: 'brand', brand: BRANDS[0] })).toBe('/shop?brand=SONY')
  })

  it('sends Ask AI to /ask with the query encoded', () => {
    expect(rowTarget({ kind: 'ask', query: 'usb-c & 100W?' })).toBe(
      '/ask?q=usb-c%20%26%20100W%3F',
    )
  })

  it('has no route for a recent search; it refills the input instead', () => {
    expect(rowTarget({ kind: 'recent', query: 'sony' })).toBeNull()
  })
})

describe('keyboard stepping', () => {
  it('wraps at both ends', () => {
    expect(step(4, 1, 5)).toBe(0)
    expect(step(0, -1, 5)).toBe(4)
    expect(step(1, 1, 5)).toBe(2)
  })

  it('stays at 0 with nothing to select', () => {
    expect(step(0, 1, 0)).toBe(0)
    expect(step(0, -1, 0)).toBe(0)
  })
})

describe('popular products', () => {
  it('picks the most reviewed, without reordering the catalogue', () => {
    const list = [product('a', 5), product('b', 50), product('c', 20), product('d', 1)]
    expect(popular(list, 3).map((p) => p.id)).toEqual(['b', 'c', 'a'])
    expect(list.map((p) => p.id)).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('recent searches', () => {
  beforeEach(() => localStorage.clear())

  it('keeps the newest first, deduplicated, at most five', () => {
    for (const q of ['a1', 'b2', 'c3', 'd4', 'e5', 'B2', 'f6']) pushRecent(q)
    expect(readRecent()).toEqual(['f6', 'B2', 'e5', 'd4', 'c3'])
    expect(JSON.parse(localStorage.getItem(RECENT_KEY)!)).toHaveLength(5)
  })

  it('ignores blank queries and trims the rest', () => {
    pushRecent('   ')
    pushRecent('  sony  ')
    expect(readRecent()).toEqual(['sony'])
  })

  it('reads corrupt or foreign data as empty', () => {
    localStorage.setItem(RECENT_KEY, '{not json')
    expect(readRecent()).toEqual([])
    localStorage.setItem(RECENT_KEY, JSON.stringify({ a: 1 }))
    expect(readRecent()).toEqual([])
    localStorage.setItem(RECENT_KEY, JSON.stringify(['ok', 3, null]))
    expect(readRecent()).toEqual(['ok'])
  })

  it('clears the history', () => {
    pushRecent('sony')
    clearRecent()
    expect(readRecent()).toEqual([])
  })

  it('survives storage that throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {
        throw new Error('blocked')
      },
    } as unknown as Storage
    expect(readRecent(broken)).toEqual([])
    expect(pushRecent('sony', broken)).toEqual(['sony'])
    expect(() => clearRecent(broken)).not.toThrow()
  })
})
