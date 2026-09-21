/**
 * One-time: record the hand-written catalogue's order as a migration.
 *
 * The curated order — phones, then laptops, then audio — lived only in the
 * index of the array in src/data/products.ts. The shop page renders that array
 * as-is (catalog.ts's 'default' sort does not sort), so it is visible
 * behaviour. Nothing in the database held it: the seed inserted all 45 rows in
 * one batch, so every row shares one created_at and `ORDER BY created_at DESC`
 * degenerates to the tiebreaker, `id` — alphabetical.
 *
 * Run once, commit the output, never run again. Like scripts/seed-catalogue.mjs
 * this reads a file that is about to be generated FROM the database; running it
 * afterwards reads back what it itself wrote.
 *
 * The loader is the esbuild-bundle-to-temp-file helper from
 * scripts/build-graph.mjs, because products.ts imports through the `@/` alias.
 */
import { writeFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const ROOT = process.cwd()

async function loadModule(entry) {
  const out = path.join(os.tmpdir(), `nexus-order-${Date.now()}.mjs`)
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

const lines = [
  '-- Generated once by scripts/order-catalogue.mjs. Do not hand-edit.',
  '--',
  '-- Where the storefront\'s product order lives.',
  '--',
  '-- Until now it lived in the index of the array in src/data/products.ts, and',
  '-- nowhere else. 0008 inserted all 45 rows in one batch, so every row carries',
  '-- the same created_at and `ORDER BY created_at DESC, id` is alphabetical by',
  '-- id in practice. Generating products.ts from that query would have shuffled',
  '-- the shop page into alphabetical order, interleaving phones with laptops,',
  '-- and no test would have gone red.',
  '--',
  '-- DEFAULT 0 rather than NULL: a product added later sorts to the front,',
  '-- which is where a new drop belongs, and it means no read has to cope with a',
  '-- missing value.',
  '',
  'ALTER TABLE products ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0;',
  '',
]

for (const [i, p] of products.entries()) {
  lines.push(`UPDATE products SET display_order = ${i} WHERE id = '${p.id.replace(/'/g, "''")}';`)
}

writeFileSync('worker/migrations/0010-display-order.sql', lines.join('\n') + '\n')
console.log(`wrote display_order for ${products.length} products`)
