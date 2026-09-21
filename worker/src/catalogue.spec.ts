import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { memoryD1 } from '../test/d1-memory'
import { products } from '@/data/products'

/** The seed migration loaded into a real database, statement by statement. */
function seeded() {
  const mem = memoryD1()
  const sql = readFileSync('worker/migrations/0008-seed-catalogue.sql', 'utf8')
  for (const stmt of sql.split(';\n')) {
    if (stmt.replace(/--[^\n]*/g, '').trim()) mem.raw.prepare(stmt).run()
  }
  return mem
}

describe('the seeded catalogue', () => {
  it('gives every product a merchant that exists', () => {
    const { raw } = seeded()
    const orphans = raw
      .prepare(
        `SELECT p.id FROM products p LEFT JOIN merchants m ON m.id = p.merchant_id
          WHERE m.id IS NULL`,
      )
      .all()
    expect(orphans).toEqual([])
  })

  it('seeds 45 published products', () => {
    const { raw } = seeded()
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM products`).get()).toEqual({ n: 45 })
    expect(
      raw.prepare(`SELECT COUNT(*) AS n FROM products WHERE status = 'published'`).get(),
    ).toEqual({ n: 45 })
  })

  it('spreads them across more than one merchant', () => {
    // A single tenant makes scopedTo and platformWide return the same thing,
    // and the isolation this project built stops being visible at all.
    const { raw } = seeded()
    const { n } = raw.prepare(`SELECT COUNT(DISTINCT merchant_id) AS n FROM products`).get() as {
      n: number
    }
    expect(n).toBeGreaterThan(1)
  })

  it('stores prices as whole minor units', () => {
    const { raw } = seeded()
    const bad = raw
      .prepare(`SELECT id FROM products WHERE typeof(price_minor) != 'integer'`)
      .all()
    expect(bad).toEqual([])
  })

  it('stores JSON columns that serialize correctly', () => {
    // The seed migration builds SQL by string concatenation into four free-text
    // JSON columns: specs, colorways, media, and specs_summary. These are the
    // highest-risk data in the catalogue because a malformed value corrupts
    // without a schema violation. JSON.parse inside the assertion names the
    // product if parsing fails, so the error is not an opaque SyntaxError.
    const { raw } = seeded()
    const rows = raw.prepare(`SELECT id, specs, colorways, media, specs_summary FROM products`).all() as Array<{
      id: string
      specs: string
      colorways: string
      media: string
      specs_summary: string
    }>

    for (const row of rows) {
      let parsed: object
      try {
        parsed = JSON.parse(row.specs)
        expect(Array.isArray(parsed)).toBe(true)
      } catch (err) {
        throw new Error(`specs for ${row.id}: ${err}`)
      }

      try {
        parsed = JSON.parse(row.colorways)
        expect(Array.isArray(parsed)).toBe(true)
      } catch (err) {
        throw new Error(`colorways for ${row.id}: ${err}`)
      }

      try {
        parsed = JSON.parse(row.media)
        expect(typeof parsed).toBe('object')
      } catch (err) {
        throw new Error(`media for ${row.id}: ${err}`)
      }

      try {
        parsed = JSON.parse(row.specs_summary)
        expect(Array.isArray(parsed)).toBe(true)
      } catch (err) {
        throw new Error(`specs_summary for ${row.id}: ${err}`)
      }
    }

    // Verify one product's structures match the TypeScript catalogue.
    const iphonePro = rows.find((r) => r.id === 'iphone-18-pro')
    expect(iphonePro).toBeDefined()

    const catalogProduct = products.find((p) => p.id === 'iphone-18-pro')
    expect(catalogProduct).toBeDefined()

    const specs = JSON.parse(iphonePro!.specs) as Array<{ label: string; value: string }>
    const colorways = JSON.parse(iphonePro!.colorways) as Array<{ name: string; hex: string }>
    const media = JSON.parse(iphonePro!.media) as { heroImage: string; hoverImage: string; thumb: string; gallery: string[] }
    const specsSummary = JSON.parse(iphonePro!.specs_summary) as string[]

    expect(specs).toEqual(catalogProduct!.specs)
    expect(colorways).toEqual(catalogProduct!.colorways)
    expect(media).toEqual(catalogProduct!.media)
    expect(specsSummary).toEqual(catalogProduct!.specsSummary)
  })
})
