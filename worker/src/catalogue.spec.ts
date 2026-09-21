import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { memoryD1 } from '../test/d1-memory'
import { products } from '@/data/products'

/**
 * A migration file run into a database, statement by statement.
 *
 * The \r?\n is not tidiness. 0001 through 0006 are CRLF in this tree, 0007
 * onwards are LF, core.autocrlf is on and no .gitattributes pins any of it —
 * so which one a file has is a property of the checkout, not of the file. Split
 * on ';\n' alone, a CRLF migration arrives as one unsplit chunk and prepare()
 * rejects it whole.
 */
function apply(mem: ReturnType<typeof memoryD1>, file: string) {
  const sql = readFileSync(`worker/migrations/${file}`, 'utf8')
  for (const stmt of sql.split(/;\r?\n/)) {
    if (stmt.replace(/--[^\n]*/g, '').trim()) mem.raw.prepare(stmt).run()
  }
}

/** The seed migration loaded into a real database, statement by statement. */
function seeded() {
  const mem = memoryD1()
  apply(mem, '0008-seed-catalogue.sql')
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

describe('order lines name their product', () => {
  /*
   * schema.sql already carries 0009's shape, so a database loaded from it has
   * nothing left to migrate and cannot hold the row this migration exists to
   * carry across. Re-running 0001 puts order_lines back the way every database
   * that has not yet had 0009 still has it — which is the only starting state
   * 0009 is written against. Replaying the migration beats pasting a copy of
   * the old CREATE TABLE here, which would be free to drift away from it.
   */
  const beforeMigration = (mem: ReturnType<typeof memoryD1>) =>
    apply(mem, '0001-order-line-variant.sql')
  const rebuild = (mem: ReturnType<typeof memoryD1>) =>
    apply(mem, '0009-order-lines-product-id.sql')

  it('carries an existing line across by resolving its sku', () => {
    const mem = seeded()
    beforeMigration(mem)
    const { raw } = mem
    const p = raw.prepare(`SELECT id, sku, merchant_id FROM products LIMIT 1`).get() as {
      id: string; sku: string; merchant_id: string
    }
    raw.prepare(`INSERT INTO orders (id, email, ship_name, ship_line1, ship_city, ship_state,
                                     ship_postal, method, subtotal_cents, shipping_cents,
                                     tax_cents, total_cents, payment_status)
                 VALUES ('o1','a@b.c','N','L','C','S','P','standard',1,0,0,1,'succeeded')`).run()
    raw.prepare(`INSERT INTO order_lines (order_id, sku, title, qty, unit_price_cents)
                 VALUES ('o1', ?, 'T', 1, 100)`).run(p.sku)

    rebuild(mem)

    expect(raw.prepare(`SELECT product_id, merchant_id FROM order_lines`).get()).toEqual({
      product_id: p.id,
      merchant_id: p.merchant_id,
    })
  })

  it('refuses to guess when a sku resolves to nothing', () => {
    const mem = seeded()
    beforeMigration(mem)
    mem.raw.prepare(`INSERT INTO orders (id, email, ship_name, ship_line1, ship_city, ship_state,
                                         ship_postal, method, subtotal_cents, shipping_cents,
                                         tax_cents, total_cents, payment_status)
                     VALUES ('o1','a@b.c','N','L','C','S','P','standard',1,0,0,1,'succeeded')`).run()
    mem.raw.prepare(`INSERT INTO order_lines (order_id, sku, title, qty, unit_price_cents)
                     VALUES ('o1','SKU-THAT-NEVER-EXISTED','T',1,100)`).run()

    // Copying this row with a NULL or invented product_id would write a false
    // record of a real transaction.
    //
    // Matched on the message rather than left as a bare toThrow(): a bare one
    // is satisfied by a typo in the filename too, so it passes whether or not
    // the guard exists. Naming the CHECK is what proves the guard is the thing
    // that fired.
    expect(() => rebuild(mem)).toThrow(/CHECK constraint failed: qty > 0/)
  })

  it('refuses to guess when a sku resolves to two merchants', () => {
    /*
     * The case this whole migration is racing: UNIQUE (merchant_id, sku) makes
     * a shared sku legal, and the backfill then has no way to tell which
     * merchant sold the thing. Both candidates copy across, so the count goes
     * UP rather than down — which the two tests above never exercise. Written
     * as `<` instead of `<>` the guard still catches a lost row and lets this
     * one through, writing two falsified lines for one real sale.
     */
    const mem = seeded()
    beforeMigration(mem)
    const p = mem.raw.prepare(`SELECT sku FROM products LIMIT 1`).get() as { sku: string }
    mem.raw.prepare(`INSERT INTO products (id, merchant_id, sku, title, brand, category,
                                           price_minor, currency, status)
                     VALUES ('rival-1','mch_sony',?,'Rival','SONY','phones',1,'USD','published')`).run(p.sku)
    mem.raw.prepare(`INSERT INTO orders (id, email, ship_name, ship_line1, ship_city, ship_state,
                                         ship_postal, method, subtotal_cents, shipping_cents,
                                         tax_cents, total_cents, payment_status)
                     VALUES ('o1','a@b.c','N','L','C','S','P','standard',1,0,0,1,'succeeded')`).run()
    mem.raw.prepare(`INSERT INTO order_lines (order_id, sku, title, qty, unit_price_cents)
                     VALUES ('o1', ?, 'T', 1, 100)`).run(p.sku)

    expect(() => rebuild(mem)).toThrow(/CHECK constraint failed: qty > 0/)
  })
})
