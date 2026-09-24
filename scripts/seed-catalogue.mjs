/**
 * One-time: turn the hand-written catalogue into a migration.
 *
 * Run once, commit the output, never run again — after Task 7 the arrow
 * reverses and products.ts is generated FROM the database. Re-running this
 * later would seed D1 from a file D1 itself produced.
 *
 * products.ts and brands.ts import through the `@/` alias, which bare Node
 * cannot resolve, so this reuses the esbuild-bundle-to-temp-file loader from
 * scripts/build-graph.mjs rather than running under
 * --experimental-strip-types.
 */
import { writeFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const ROOT = process.cwd()

async function loadModule(entry) {
  const out = path.join(os.tmpdir(), `nexus-seed-${Date.now()}.mjs`)
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: out,
    alias: { '@': path.join(ROOT, 'src') },
    logLevel: 'silent',
  })
  try {
    return await import(pathToFileURL(out).href)
  } finally {
    await fs.rm(out, { force: true })
  }
}

const { products } = await loadModule('src/data/products.ts')
const { brands } = await loadModule('src/data/brands.ts')

const q = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`)

// Brand ids are uppercase (APPLE, SAMSUNG, ...); lowercase for the id/slug so
// they read as the rest of the schema's identifiers do.
const merchants = [...new Set(products.map((p) => p.brand))].map((id) => {
  const brand = brands.find((b) => b.id === id)
  if (!brand) throw new Error(`no brand record for ${id}`)
  const lower = id.toLowerCase()
  return { id: `mch_${lower}`, slug: lower, name: brand.name }
})

const lines = [
  '-- Generated once by scripts/seed-catalogue.mjs. Do not hand-edit; do not',
  '-- regenerate. After the build-catalog generator lands, products.ts is',
  '-- produced FROM this data, and re-running the seed would close a loop.',
  '--',
  '-- One merchant per brand. These are demo entities in a portfolio project,',
  '-- not a claim of any commercial relationship. Every merchant settles in USD;',
  '-- multi-currency belongs to the money and FX plan, and seeding one currency',
  '-- means the first FX bug is found by that plan rather than hidden here.',
  '',
]

for (const m of merchants) {
  lines.push(
    `INSERT INTO merchants (id, slug, name, settlement_currency, status) VALUES ` +
      `(${q(m.id)}, ${q(m.slug)}, ${q(m.name)}, 'USD', 'active');`,
  )
}
lines.push('')

for (const p of products) {
  lines.push(
    `INSERT INTO products (id, merchant_id, sku, title, brand, category, price_minor,` +
      ` currency, status, stock_count, badge, rating, review_count, specs, colorways,` +
      ` media, specs_summary) VALUES (` +
      [
        q(p.id),
        q(`mch_${p.brand.toLowerCase()}`),
        q(p.sku),
        q(p.title),
        q(p.brand),
        q(p.category),
        p.priceMinor,
        q(p.currency),
        `'published'`,
        p.stockCount,
        q(p.badge ?? null),
        p.rating,
        p.reviewCount,
        q(JSON.stringify(p.specs)),
        q(JSON.stringify(p.colorways)),
        q(JSON.stringify(p.media)),
        q(JSON.stringify(p.specsSummary)),
      ].join(', ') +
      ');',
  )
}

writeFileSync('worker/migrations/0008-seed-catalogue.sql', lines.join('\n') + '\n')
console.log(`wrote ${merchants.length} merchants and ${products.length} products`)
