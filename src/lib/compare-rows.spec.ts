import { describe, it, expect } from 'vitest'
import { buildRows } from './compare-rows'
import { products } from '@/data/products'
import type { Product } from '@/types'

const byId = (id: string) => products.find((p) => p.id === id)!
const phones = products.filter((p) => p.category === 'phones')
const row = (rows: ReturnType<typeof buildRows>, label: string) =>
  rows.find((r) => r.label === label)
const winners = (rows: ReturnType<typeof buildRows>, label: string) =>
  row(rows, label)!.cells.flatMap((c, i) => (c.best ? [i] : []))

describe('buildRows', () => {
  it('picks the cheapest as the winner on price, not the dearest', () => {
    const items = [phones[0], phones[1], phones[2]]
    const rows = buildRows(items)
    const prices = items.map((p) => p.price)
    const cheapest = prices.indexOf(Math.min(...prices))
    expect(winners(rows, 'Price')).toEqual([cheapest])
  })

  it('picks the highest rating', () => {
    const items = [phones[0], phones[1], phones[2]]
    const ratings = items.map((p) => p.rating)
    expect(winners(buildRows(items), 'Rating')).toEqual([ratings.indexOf(Math.max(...ratings))])
  })

  it('declares no winner on screen size', () => {
    // The rule this feature exists to get right. A bigger screen is a different
    // phone, not a better one, and a green tick would be a fabricated verdict.
    const rows = buildRows(phones.slice(0, 3))
    const screen = row(rows, 'Screen')!
    expect(screen.cells.some((c) => c.value !== null)).toBe(true)
    expect(winners(rows, 'Screen')).toEqual([])
  })

  it('declares no winner on a row where every column agrees', () => {
    // Identical in everything the table shows, including the sku — which is a
    // row now, and a product that differs there differs, correctly.
    const one = byId('iphone-18-pro')
    const rows = buildRows([one, { ...one, id: 'clone' } as Product])
    for (const r of rows) {
      expect(r.cells.every((c) => !c.best), `${r.label} should have no winner`).toBe(true)
      expect(r.same).toBe(true)
    }
  })

  it('does not crown a lone published figure', () => {
    // One product naming a number does not beat three that stay silent; that
    // reports the others as worse when they are only unknown.
    const base = byId('iphone-18-pro')
    const withFigure = { ...base, specs: [{ label: 'Charging', value: '120W wired' }] } as Product
    const without = { ...base, id: 'b', specs: [], specsSummary: [] } as Product
    const rows = buildRows([withFigure, without])
    const charging = row(rows, 'Charging')
    if (charging) expect(charging.cells.every((c) => !c.best)).toBe(true)
  })

  it('renders an unpublished figure as null rather than zero', () => {
    // An omitted field read as zero is a defect this project has shipped once:
    // the assistant called a battery "smaller" where none was published.
    const bare = { ...byId('iphone-18-pro'), specs: [], specsSummary: [] } as Product
    const rows = buildRows([byId('iphone-18-pro'), bare])
    for (const r of rows) {
      for (const cell of r.cells) {
        expect(cell.value, `${r.label} must not fabricate a zero`).not.toBe(0)
      }
    }
  })

  it('drops a row no product in the comparison publishes', () => {
    const bare = [
      { ...byId('iphone-18-pro'), specs: [], specsSummary: [] } as Product,
      { ...byId('iphone-18-pro'), id: 'b', specs: [], specsSummary: [] } as Product,
    ]
    const labels = buildRows(bare).map((r) => r.label)
    // Price and brand always resolve; a spec nobody states should not appear as
    // a line of dashes pushing real rows off the screen.
    expect(labels).toContain('Price')
    expect(labels).not.toContain('Refresh rate')
  })

  it('gives every category a set of rows that actually resolve', () => {
    // Guards the Record<CategoryId, …> table against a category whose rows all
    // read fields its products never publish — which compiles, and renders an
    // empty comparison.
    for (const category of ['phones', 'computing', 'audio', 'imaging', 'peripherals'] as const) {
      const items = products.filter((p) => p.category === category).slice(0, 3)
      // Named per category rather than "anything that is not universal", so the
      // guard keeps its teeth as universal rows are added.
      const expected: Record<string, string> = {
        phones: 'Refresh rate',
        computing: 'Memory',
        audio: 'Battery life',
        imaging: 'Main camera',
        peripherals: 'Battery life',
      }
      const labels = buildRows(items).map((r) => r.label)
      expect(labels, `${category} resolved no category rows`).toContain(expected[category])
    }
  })

  it('returns nothing for an empty comparison', () => {
    expect(buildRows([])).toEqual([])
  })
})

describe('the published-spec union', () => {
  const specRows = (items: Product[]) => buildRows(items).filter((r) => r.group === 'spec')

  it('carries every label any product publishes', () => {
    const items = products.filter((p) => p.category === 'phones').slice(0, 4)
    const published = new Set(items.flatMap((p) => p.specs.map((s) => s.label.trim().toLowerCase())))
    const rendered = new Set(specRows(items).map((r) => r.label.toLowerCase()))
    expect(rendered).toEqual(published)
  })

  it('keeps a label only one product publishes, and marks it uncomparable', () => {
    // The point of "everything": a spec nobody else states is still worth
    // seeing. It just cannot be compared, and says so.
    const a = { ...byId('iphone-18-pro'), specs: [{ label: 'Unique Thing', value: 'yes' }] } as Product
    const b = { ...byId('iphone-18-pro'), id: 'b', specs: [] } as Product
    const row = specRows([a, b]).find((r) => r.label === 'Unique Thing')!
    expect(row.cells.map((c) => c.value)).toEqual(['yes', null])
    expect(row.comparable).toBe(false)
  })

  it('never puts a verdict on published text', () => {
    // Free text has no direction. "Snapdragon 8 Elite Gen 5" does not beat
    // "A20 Pro", and nothing here should imply that it does.
    const items = products.filter((p) => p.category === 'computing').slice(0, 4)
    for (const row of specRows(items)) {
      expect(row.cells.every((c) => !c.best), `${row.label} must carry no winner`).toBe(true)
    }
  })

  it('puts the rows every product answers first', () => {
    // A union across four products is mostly holes — four peripherals give 27
    // labels, none answered by all four — so coverage decides the order or the
    // useful rows are buried.
    const items = products.filter((p) => p.category === 'imaging').slice(0, 4)
    const filled = specRows(items).map((r) => r.cells.filter((c) => c.value !== null).length)
    expect(filled).toEqual([...filled].sort((a, b) => b - a))
  })

  it('treats labels that differ only in case or padding as one row', () => {
    const a = { ...byId('iphone-18-pro'), specs: [{ label: 'Battery', value: 'A' }] } as Product
    const b = { ...byId('iphone-18-pro'), id: 'b', specs: [{ label: ' battery ', value: 'B' }] } as Product
    const rows = specRows([a, b]).filter((r) => r.label.toLowerCase() === 'battery')
    expect(rows).toHaveLength(1)
    expect(rows[0].cells.map((c) => c.value)).toEqual(['A', 'B'])
  })

  it('does not merge labels that merely look related', () => {
    // "Chip" and "Processor" may well mean the same part, but deciding that is
    // guessing, and a wrong merge silently compares two different figures.
    const a = { ...byId('iphone-18-pro'), specs: [{ label: 'Chip', value: 'A20' }] } as Product
    const b = { ...byId('iphone-18-pro'), id: 'b', specs: [{ label: 'Processor', value: 'X2' }] } as Product
    expect(specRows([a, b]).map((r) => r.label)).toEqual(['Chip', 'Processor'])
  })

  it('keeps the comparable figures above the published text', () => {
    const groups = buildRows(products.filter((p) => p.category === 'phones').slice(0, 3)).map(
      (r) => r.group,
    )
    expect(groups.indexOf('spec')).toBeGreaterThan(groups.lastIndexOf('measured'))
  })

  it('lets a label appear in both groups without collapsing them', () => {
    // "Storage" is a number above and "256GB / 512GB / 1TB / 2TB" below. Both
    // are true; running them together would read as a contradiction.
    const rows = buildRows(products.filter((p) => p.category === 'phones').slice(0, 4))
    const storage = rows.filter((r) => r.label.toLowerCase() === 'storage')
    expect(storage.length).toBeGreaterThan(1)
    expect(new Set(storage.map((r) => r.group))).toEqual(new Set(['measured', 'spec']))
  })
})

describe('the rest of the catalogue record', () => {
  const items = products.filter((p) => p.category === 'phones').slice(0, 3)
  const measured = (label: string) => buildRows(items).find((r) => r.label === label)!

  it('puts the review count directly under the rating, with no verdict', () => {
    // 4.8 from twelve reviews and 4.8 from two thousand are the same number and
    // not the same claim, so the count sits where it qualifies the score. More
    // reviews is not a better product, so nothing is crowned.
    const labels = buildRows(items).map((r) => r.label)
    expect(labels.indexOf('Reviews')).toBe(labels.indexOf('Rating') + 1)
    expect(measured('Reviews').cells.every((c) => !c.best)).toBe(true)
    expect(measured('Reviews').cells[0].value).toMatch(/^[\d,]+$/)
  })

  it('states availability without ranking it', () => {
    // A tick beside "In stock" would read as a verdict on the product, and 48
    // units in a warehouse is not better than 11.
    const row = measured('Availability')
    expect(row.cells.every((c) => !c.best)).toBe(true)
    expect(String(row.cells[0].value)).toMatch(/In stock|Out of stock/)
  })

  it('reports an out-of-stock product as out of stock, not as zero left', () => {
    const gone = { ...byId('iphone-18-pro'), id: 'gone', inStock: false, stockCount: 0 } as Product
    const rows = buildRows([byId('iphone-18-pro'), gone])
    expect(rows.find((r) => r.label === 'Availability')!.cells[1].value).toBe('Out of stock')
  })

  it('lists colourways, highlights and the sku', () => {
    for (const label of ['Colours', 'Highlights', 'SKU']) {
      const row = measured(label)
      expect(row.cells.every((c) => c.value !== null), `${label} should resolve`).toBe(true)
      expect(row.cells.every((c) => !c.best), `${label} cannot be won`).toBe(true)
    }
  })

  it('leaves the badge blank rather than inventing one', () => {
    const plain = { ...byId('iphone-18-pro'), id: 'plain', badge: undefined } as Product
    const rows = buildRows([byId('iphone-18-pro'), plain])
    const badge = rows.find((r) => r.label === 'Badge')!
    expect(badge.cells[0].value).toBe('New drop')
    expect(badge.cells[1].value).toBeNull()
  })

  it('keeps identity rows below the specifications they identify', () => {
    const labels = buildRows(items)
      .filter((r) => r.group === 'measured')
      .map((r) => r.label)
    expect(labels.indexOf('SKU')).toBeGreaterThan(labels.indexOf('Refresh rate'))
  })
})
