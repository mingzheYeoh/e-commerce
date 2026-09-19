/**
 * Measures retrieval quality instead of asserting it.
 *
 * "The search feels smarter" is not a claim anyone can check. This runs the
 * keyword engine, the embedding model and a hybrid of the two over a fixed set
 * of shopper questions and prints precision@3, recall@5 and MRR for each, so a
 * change to retrieval is a number that moved rather than a vibe.
 *
 *   node scripts/eval-search.mjs
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'
import { pipeline } from '@huggingface/transformers'

const MODEL = 'Xenova/all-MiniLM-L6-v2'
const ROOT = process.cwd()

/** Bundles a TS module (resolving the `@/` alias) so Node can import it. */
async function loadModule(entry) {
  const out = path.join(os.tmpdir(), `nexus-eval-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
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

/*
 * Metrics and fusion are imported from src/lib/retrieval.ts, not reimplemented
 * here. A second copy would drift, and the eval would end up scoring code that
 * never runs in front of a shopper.
 */
const { dot, fuseRanks, precisionAt, recallAt, reciprocalRank } = await loadModule(
  'src/lib/retrieval.ts',
)

/* -------------------------------------------------------------------- main */

const evalSet = JSON.parse(await fs.readFile('src/lib/search-eval.json', 'utf8')).queries
const index = JSON.parse(await fs.readFile('public/media/search/products.json', 'utf8'))
const vectors = new Float32Array((await fs.readFile('public/media/search/products.bin')).buffer.slice(0))

const { recommend } = await loadModule('src/lib/recommend.ts')
const embed = await pipeline('feature-extraction', MODEL, { dtype: 'q8' })

const semanticFor = async (q) => {
  const out = await embed([q], { pooling: 'mean', normalize: true })
  const query = Float32Array.from(out.data)
  return index.slugs
    .map((id, i) => ({ id, score: dot(query, vectors, i * index.dims, index.dims) }))
    .sort((a, b) => b.score - a.score)
    .map((r) => r.id)
}

const runs = { keyword: [], semantic: [], hybrid: [] }
const perQuery = []

for (const { q, relevant } of evalSet) {
  const keyword = recommend(q, 45).items.map((r) => r.product.id)
  const semantic = await semanticFor(q)
  const hybrid = fuseRanks([keyword, semantic])

  for (const [name, ranked] of Object.entries({ keyword, semantic, hybrid })) {
    runs[name].push({
      p3: precisionAt(ranked, relevant, 3),
      r5: recallAt(ranked, relevant, 5),
      mrr: reciprocalRank(ranked, relevant),
    })
  }
  perQuery.push({
    q,
    keyword: reciprocalRank(keyword, relevant),
    semantic: reciprocalRank(semantic, relevant),
  })
}

const mean = (rows, key) => rows.reduce((s, r) => s + r[key], 0) / rows.length
const pct = (n) => (n * 100).toFixed(1).padStart(5) + '%'

console.log(`\n${evalSet.length} queries, ${index.count} products, model ${index.model}\n`)
console.log('  strategy    precision@3   recall@5      MRR')
console.log('  ' + '-'.repeat(46))
for (const [name, rows] of Object.entries(runs)) {
  console.log(`  ${name.padEnd(12)}${pct(mean(rows, 'p3'))}       ${pct(mean(rows, 'r5'))}     ${pct(mean(rows, 'mrr'))}`)
}

const regressions = perQuery.filter((r) => r.semantic < r.keyword)
console.log(`\n  queries where the keyword engine still wins: ${regressions.length}/${evalSet.length}`)
for (const r of regressions) {
  console.log(`    kw ${r.keyword.toFixed(2)}  sem ${r.semantic.toFixed(2)}   "${r.q}"`)
}
