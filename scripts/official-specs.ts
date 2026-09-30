/**
 * Turns scripts/official-specs.json into the catalogue it describes.
 *
 * The JSON holds, for every product, the manufacturer's published figures and
 * the pages they were read from. This writes them out twice, the same way
 * everything else in the catalogue travels:
 *
 *   worker/migrations/0019-official-specs.sql   the UPDATEs, to apply to D1
 *   src/data/products.ts                        the build snapshot, regenerated
 *                                               from the seed plus that
 *                                               migration, as catalogue.spec.ts
 *                                               checks it
 *
 * and prints what the assistant will now read out of each product's specs
 * (screen, refresh, battery, charging...), because a spec rewritten in new
 * words can quietly stop parsing.
 *
 *   npx vite-node scripts/official-specs.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { memoryD1, type MemoryD1 } from '../worker/test/d1-memory'
import { QUERY, toProduct, render } from './build-catalog.mjs'
import { extractFacts } from '../src/lib/extract-facts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const at = (p: string) => path.join(ROOT, p)
const MIGRATION = 'worker/migrations/0019-official-specs.sql'

interface Entry {
  id: string
  unchanged?: boolean
  title?: string
  sku?: string
  price?: number
  summary?: string[]
  specs?: [string, string][]
  sources: string[]
}
const data = JSON.parse(readFileSync(at('scripts/official-specs.json'), 'utf8')) as { checked: string; products: Entry[] }

/* ---------------------------------------------------------------- checks */

const problems: string[] = []
const seen = new Set<string>()
for (const e of data.products) {
  const say = (m: string) => problems.push(`${e.id}: ${m}`)
  if (seen.has(e.id)) say('listed twice')
  seen.add(e.id)
  if (!e.sources?.length || e.sources.some((s) => !/^https:\/\/\S+$/.test(s))) say('needs https sources')
  if (e.unchanged) continue
  if (e.summary?.length !== 3 || e.summary.some((s) => !s.trim() || s.length > 40)) say('summary is three lines of 40 characters at most')
  if (!e.specs?.length || e.specs.length > 14) say('specs are 1 to 14 rows')
  const labels = (e.specs ?? []).map(([l]) => l.toLowerCase())
  if (new Set(labels).size !== labels.length) say('spec labels repeat')
  if ((e.specs ?? []).some(([l, v]) => !l.trim() || !v.trim() || /[\r\n]/.test(l + v))) say('empty or multi-line spec')
  if (e.price !== undefined && !(e.price > 0 && Number.isInteger(Math.round(e.price * 100)) && Math.abs(e.price * 100 - Math.round(e.price * 100)) < 1e-6)) {
    say('price is a positive amount in dollars and cents')
  }
  if (e.sku !== undefined && !/^[A-Z0-9]+(?:-[A-Z0-9]+)+$/.test(e.sku)) say('sku is upper-case, hyphenated')
}
if (problems.length) throw new Error(`official-specs.json:\n  ${problems.join('\n  ')}`)

/* ------------------------------------------------------------- migration */

const q = (s: string) => `'${s.replace(/'/g, "''")}'`
const updates = data.products
  .filter((e) => !e.unchanged)
  .map((e) => {
    const set = [
      ...(e.title ? [`title = ${q(e.title)}`] : []),
      ...(e.sku ? [`sku = ${q(e.sku)}`] : []),
      ...(e.price !== undefined ? [`price_minor = ${Math.round(e.price * 100)}`] : []),
      `specs = ${q(JSON.stringify(e.specs!.map(([label, value]) => ({ label, value }))))}`,
      `specs_summary = ${q(JSON.stringify(e.summary))}`,
      `updated_at = datetime('now')`,
    ]
    return `UPDATE products SET ${set.join(', ')} WHERE id = ${q(e.id)};`
  })

// No semicolons in the comments: catalogue.spec.ts splits this file on them.
const header = `-- ---------------------------------------------------------------- 0019
-- Every product's specs, card highlights and, where the product itself was
-- wrong, title, sku or price, replaced with the manufacturers' published
-- figures as read on ${data.checked}. Sources per product are in
-- scripts/official-specs.json, and scripts/official-specs.ts writes this file.
--
-- Data only, no schema change, so it is safe in either order relative to the
-- workers. It does overwrite the columns it names, including any edit a
-- merchant made to them in the console.
--
--   cd worker
--   npx wrangler d1 execute nexus-orders-staging --remote --file=migrations/0019-official-specs.sql
`
writeFileSync(at(MIGRATION), `${header}\n${updates.join('\n')}\n`)

/* -------------------------------------------------------------- snapshot */

/** A migration run statement by statement, as catalogue.spec.ts runs it. */
function apply(mem: MemoryD1, file: string, only?: RegExp) {
  for (const stmt of readFileSync(at(`worker/migrations/${file}`), 'utf8').split(/;\r?\n/)) {
    const bare = stmt.replace(/--[^\n]*/g, '').trim()
    if (bare && (!only || only.test(bare))) mem.raw.prepare(stmt).run()
  }
}
const mem = memoryD1()
apply(mem, '0008-seed-catalogue.sql')
// 0010's ALTER is already in schema.sql. Its UPDATEs are the display order.
for (const stmt of readFileSync(at('worker/migrations/0010-display-order.sql'), 'utf8').split(';')) {
  if (stmt.trim().startsWith('UPDATE')) mem.raw.prepare(stmt.trim()).run()
}
apply(mem, '0017-media-on-r2.sql')
apply(mem, '0019-official-specs.sql')
const products = mem.raw.prepare(QUERY).all().map(toProduct)
writeFileSync(at('src/data/products.ts'), render(products))

/* ------------------------------------------------------------ what parses */

console.log(`Wrote ${updates.length} UPDATEs to ${MIGRATION} and ${products.length} products to src/data/products.ts\n`)
const rows = products.map((p: Parameters<typeof extractFacts>[0] & { id: string }) => {
  const f = extractFacts(p)
  return {
    id: p.id,
    screen: f.screenInches ?? '',
    hz: f.refreshHz ?? '',
    mAh: f.batteryMah ?? '',
    hours: f.batteryHours ?? '',
    watts: f.chargeWatts ?? '',
    mp: f.megapixels ?? '',
    ram: f.memoryGb ?? '',
    storage: f.storageGb ?? '',
  }
})
console.table(rows)
