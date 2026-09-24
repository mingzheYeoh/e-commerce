/**
 * Derives the product knowledge graph from the catalogue.
 *
 * Nothing here is hand-entered. Every node and edge is computed from data that
 * already exists, so the graph cannot drift away from the products it describes
 * — add a product and re-run, and the graph is correct again.
 *
 * Two outputs, deliberately:
 *   public/media/search/graph.json  a static snapshot the browser can query
 *                                   with no network, and the fallback when the
 *                                   graph database is unreachable
 *   scripts/graph.cypher            the load script for Neo4j
 *
 * The snapshot is the source of truth. Neo4j is loaded *from* it rather than
 * being the system of record, so a paused free-tier instance degrades the
 * answers rather than breaking the storefront.
 *
 *   node scripts/build-graph.mjs
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const ROOT = process.cwd()
const OUT_JSON = 'public/media/search/graph.json'
const OUT_CYPHER = 'scripts/graph.cypher'

async function loadModule(entry) {
  const out = path.join(os.tmpdir(), `nexus-graph-${Date.now()}.mjs`)
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
const { extractFacts } = await loadModule('src/lib/extract-facts.ts')

/* ------------------------------------------------------------------- nodes */

const facts = new Map(products.map((p) => [p.id, extractFacts(p)]))

const nodes = {
  Product: products.map((p) => ({
    id: p.id,
    title: p.title,
    // The graph's `price` property stays dollar-denominated. Cypher consumers
    // render it straight into text the user reads (`$${r.price}` in tools.ts
    // and rag.ts), so writing minor units here would quote a phone at $89,999.
    // The catalogue is integer cents; this is the boundary where it stops being.
    price: p.priceMinor / 100,
    rating: p.rating,
    inStock: p.inStock,
    ...Object.fromEntries(
      Object.entries(facts.get(p.id)).filter(([, v]) => typeof v === 'number'),
    ),
  })),
  Brand: brands.map((b) => ({ id: b.id, name: b.name })),
  Category: [...new Set(products.map((p) => p.category))].map((id) => ({ id })),
  Port: [...new Set(products.flatMap((p) => facts.get(p.id).ports))].map((id) => ({ id })),
  Feature: [...new Set(products.flatMap((p) => facts.get(p.id).features))].map((id) => ({ id })),
}

/* ------------------------------------------------------------------- edges */

const edges = []
const add = (from, type, to, props = {}) => edges.push({ from, type, to, ...props })

for (const p of products) {
  const f = facts.get(p.id)
  add(p.id, 'MADE_BY', p.brand)
  add(p.id, 'IN_CATEGORY', p.category)
  for (const port of f.ports) add(p.id, 'HAS_PORT', port)
  for (const feat of f.features) add(p.id, 'HAS_FEATURE', feat)
}

/**
 * Rivals: same category, price within 40% of each other.
 *
 * Price proximity is what makes two products alternatives rather than merely
 * related — a $79 mouse and a $4,000 camera share a shop, not a decision.
 */
for (const a of products) {
  for (const b of products) {
    if (a.id >= b.id || a.category !== b.category) continue
    // A ratio of cents equals a ratio of dollars, so this one needs no conversion.
    const ratio = Math.min(a.priceMinor, b.priceMinor) / Math.max(a.priceMinor, b.priceMinor)
    if (ratio >= 0.6) add(a.id, 'COMPETES_WITH', b.id, { priceRatio: Number(ratio.toFixed(3)) })
  }
}

/**
 * Accessories: what a shopper plausibly buys alongside.
 *
 * Derived from category and connector rather than from sales data, which this
 * project does not have. A charger pairs with anything that takes USB-C; input
 * devices pair with the machines they plug into.
 */
const isPower = (p) => /charger|powerbank|bank/.test(p.id)
const isInput = (p) => p.category === 'peripherals' && !/monitor|odyssey/.test(p.id)
const isMachine = (p) => p.category === 'computing' && !/watch|charger|bank/.test(p.id)

for (const a of products) {
  for (const b of products) {
    if (a.id === b.id) continue
    const fb = facts.get(b.id)
    if (isPower(a) && fb.ports.includes('USB-C') && !isPower(b)) add(a.id, 'POWERS', b.id)
    if (isInput(a) && isMachine(b)) add(a.id, 'PAIRS_WITH', b.id)
    if (a.category === 'audio' && (b.category === 'phones' || isMachine(b))) {
      add(a.id, 'PAIRS_WITH', b.id)
    }
  }
}

/* ----------------------------------------------------------------- outputs */

await fs.mkdir(path.dirname(OUT_JSON), { recursive: true })
await fs.writeFile(OUT_JSON, JSON.stringify({ nodes, edges }, null, 1) + '\n')

/**
 * Emits a handful of UNWIND batches rather than one statement per row.
 *
 * The first version wrote 600 separate statements, which the Aura query editor
 * runs one at a time and which pays a transaction per row. UNWIND over an
 * inline list is the idiomatic bulk load: nine statements total, one round trip
 * each, and small enough to paste into a browser console.
 */
/**
 * A Cypher map literal.
 *
 * Cypher requires bare keys: `{priceRatio: 0.9}` is valid and
 * `{"priceRatio": 0.9}` is a syntax error. JSON.stringify quotes every key, so
 * it can only be trusted for the *values* — and the recursion matters, because
 * a nested map emitted as JSON fails at load time, not at generation time.
 */
function mapLiteral(o) {
  const value = (v) =>
    v !== null && typeof v === 'object' && !Array.isArray(v) ? mapLiteral(v) : JSON.stringify(v)
  return '{' + Object.entries(o).map(([k, v]) => `${k}: ${value(v)}`).join(', ') + '}'
}

const lines = [
  '// Generated by scripts/build-graph.mjs — do not edit by hand.',
  '//',
  '// Paste the whole file into the Aura console Query tab, or:',
  '//   cat scripts/graph.cypher | cypher-shell -a <uri> -u neo4j -p <password>',
  '//',
  '// Written as UNWIND batches, so this is nine statements rather than one per',
  '// row. Re-running is safe: it clears the graph first and MERGEs by id.',
  '',
  'MATCH (n) DETACH DELETE n;',
  '',
  'CREATE CONSTRAINT product_id IF NOT EXISTS FOR (p:Product) REQUIRE p.id IS UNIQUE;',
  'CREATE CONSTRAINT brand_id IF NOT EXISTS FOR (b:Brand) REQUIRE b.id IS UNIQUE;',
  '',
]

for (const [label, rows] of Object.entries(nodes)) {
  lines.push(
    `UNWIND [${rows.map(mapLiteral).join(', ')}] AS row`,
    `CREATE (n:${label}) SET n = row;`,
    '',
  )
}

// Relationship types cannot be parameterised in Cypher, so one batch per type.
const edgesByType = {}
for (const e of edges) (edgesByType[e.type] ??= []).push(e)

for (const [type, rows] of Object.entries(edgesByType)) {
  // `type` must be pulled out too: it names the relationship, and leaving it in
  // the rest would write it back as a property duplicating the edge's own type.
  const payload = rows.map(({ from, to, type: _type, ...props }) =>
    mapLiteral({ from, to, ...(Object.keys(props).length ? { props } : {}) }),
  )
  const setProps = payload.some((p) => p.includes('props:')) ? ' SET r += row.props' : ''
  lines.push(
    `UNWIND [${payload.join(', ')}] AS row`,
    `MATCH (a {id: row.from}), (b {id: row.to})`,
    `CREATE (a)-[r:${type}]->(b)${setProps};`,
    '',
  )
}

await fs.writeFile(OUT_CYPHER, lines.join('\n') + '\n')

const counts = Object.entries(nodes).map(([k, v]) => `${k} ${v.length}`).join(', ')
const byType = edges.reduce((acc, e) => ((acc[e.type] = (acc[e.type] ?? 0) + 1), acc), {})
console.log(`nodes:  ${counts}`)
console.log(`edges:  ${Object.entries(byType).map(([k, v]) => `${k} ${v}`).join(', ')}`)
console.log(`total:  ${Object.values(nodes).flat().length} nodes, ${edges.length} relationships`)
console.log(`wrote:  ${OUT_JSON}, ${OUT_CYPHER}`)
