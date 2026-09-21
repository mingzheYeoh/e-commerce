import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { memoryD1 } from '../test/d1-memory'

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
})
