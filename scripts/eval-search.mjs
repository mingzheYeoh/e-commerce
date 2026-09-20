/**
 * Measures retrieval quality instead of asserting it.
 *
 * "The search feels smarter" is not a claim anyone can check. This runs each
 * retrieval strategy over a fixed set of shopper questions and prints
 * precision@3, recall@5 and MRR, so a change to retrieval is a number that
 * moved rather than a vibe.
 *
 *   node scripts/eval-search.mjs            # on-device backends only
 *   node scripts/eval-search.mjs --remote   # also score the hosted index
 *   node scripts/eval-search.mjs --ablate   # separate model from document text
 *
 * With --remote it scores two retrieval stacks that share nothing but the
 * catalogue and this evaluation set:
 *
 *   on-device   MiniLM-L6-v2 (q8, mean pooling), vectors shipped as a 67 KB
 *               binary, 45 dot products in the visitor's browser.
 *   hosted      bge-small-en-v1.5 on Workers AI (cls pooling), approximate
 *               nearest neighbour over Cloudflare Vectorize.
 *
 * Those two differ in two ways at once — the model AND the text each product is
 * embedded as — so "hosted retrieves better" is unattributable from the headline
 * table alone. `--ablate` holds one constant while varying the other, scoring
 * every combination locally with exact cosine.
 *
 * The latency columns are not measuring the same thing and are labelled so:
 * on-device excludes the one-off model download and is timed in Node rather
 * than a browser, hosted is wall clock from this machine and therefore includes
 * the round trip to Cloudflare. Read them as orders of magnitude, not as a
 * benchmark.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'
import { pipeline } from '@huggingface/transformers'

const MODEL = 'Xenova/all-MiniLM-L6-v2'
const ROOT = process.cwd()
const REMOTE = process.argv.includes('--remote')
const ABLATE = process.argv.includes('--ablate')
const API = process.env.NEXUS_API ?? 'https://nexus-api.mingzhe030228.workers.dev'

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

/**
 * Asks the deployed worker for a ranking, with no model in the loop.
 *
 * topK is the whole catalogue so MRR is comparable: truncating the ranking
 * would score a backend 0 on any query whose first relevant hit fell outside
 * the window, which measures the window rather than the retrieval.
 */
async function vectorizeFor(q) {
  const started = Date.now()
  const res = await fetch(`${API}/api/search?q=${encodeURIComponent(q)}&k=50`)
  if (!res.ok) throw new Error(`${API} answered ${res.status} for "${q}"`)
  const body = await res.json()
  return { ids: body.ids, wall: Date.now() - started, ...body.timing }
}

const timings = { device: [], hosted: [], hostedEmbed: [], hostedQuery: [] }
const runs = { keyword: [], semantic: [], hybrid: [] }
if (REMOTE) Object.assign(runs, { vectorize: [], 'vectorize+kw': [] })
const perQuery = []

if (REMOTE) {
  // One call that is not counted. The first request to a cold worker pays for
  // the isolate, the model and the index all at once, and reporting that as
  // typical latency would be the most flattering-to-nobody number available.
  process.stdout.write('warming the worker … ')
  await vectorizeFor('warm up')
  console.log('done')
}

for (const { q, relevant } of evalSet) {
  const keyword = recommend(q, 45).items.map((r) => r.product.id)

  const t0 = Date.now()
  const semantic = await semanticFor(q)
  timings.device.push(Date.now() - t0)

  const hybrid = fuseRanks([keyword, semantic])
  const ranked = { keyword, semantic, hybrid }

  if (REMOTE) {
    const remote = await vectorizeFor(q)
    timings.hosted.push(remote.wall)
    timings.hostedEmbed.push(remote.embed)
    timings.hostedQuery.push(remote.query)
    ranked.vectorize = remote.ids
    ranked['vectorize+kw'] = fuseRanks([keyword, remote.ids])
  }

  for (const [name, list] of Object.entries(ranked)) {
    runs[name].push({
      p3: precisionAt(list, relevant, 3),
      r5: recallAt(list, relevant, 5),
      mrr: reciprocalRank(list, relevant),
    })
  }

  perQuery.push({
    q,
    relevant,
    keyword: reciprocalRank(keyword, relevant),
    semantic: reciprocalRank(semantic, relevant),
    vectorize: REMOTE ? reciprocalRank(ranked.vectorize, relevant) : null,
  })
}

/* ----------------------------------------------------------------- ablate */

/**
 * Which of the two changes actually bought the improvement.
 *
 * Runs every (model x document text) combination over the same queries with
 * exact cosine, so the hosted stack's advantage can be attributed rather than
 * assumed. Exact rather than approximate on purpose: this isolates the
 * retrieval quality of the vectors, with the ANN index taken out of the
 * picture entirely.
 */
async function ablate() {
  const { products } = await loadModule('src/data/products.ts')
  const { documentFor, passageFor } = await loadModule('src/lib/passages.ts')

  const models = [
    { name: 'MiniLM-L6', id: 'Xenova/all-MiniLM-L6-v2', pooling: 'mean' },
    { name: 'bge-small', id: 'Xenova/bge-small-en-v1.5', pooling: 'cls' },
  ]
  const corpora = [
    { name: 'specs only', of: documentFor },
    { name: 'prose + facts', of: passageFor },
  ]

  const table = []
  for (const model of models) {
    console.log(`  loading ${model.id} …`)
    const pipe = await pipeline('feature-extraction', model.id, { dtype: 'q8' })
    const embedAll = async (texts) => {
      const out = await pipe(texts, { pooling: model.pooling, normalize: true })
      return { data: Float32Array.from(out.data), dims: out.dims[1] }
    }
    // Queries are embedded once per model, not once per corpus: the same model
    // reads the query the same way whatever the documents look like.
    const q = await embedAll(evalSet.map((e) => e.q))

    for (const corpus of corpora) {
      const docs = await embedAll(products.map(corpus.of))
      const rows = evalSet.map((entry, qi) => {
        const query = q.data.subarray(qi * q.dims, (qi + 1) * q.dims)
        const list = products
          .map((p, i) => ({ id: p.id, score: dot(query, docs.data, i * docs.dims, docs.dims) }))
          .sort((a, b) => b.score - a.score)
          .map((r) => r.id)
        return {
          p3: precisionAt(list, entry.relevant, 3),
          r5: recallAt(list, entry.relevant, 5),
          mrr: reciprocalRank(list, entry.relevant),
        }
      })
      table.push({ model: model.name, corpus: corpus.name, rows })
    }
  }
  return table
}

/* ------------------------------------------------------------------ report */

const mean = (rows, key) => rows.reduce((s, r) => s + r[key], 0) / rows.length
const pct = (n) => (n * 100).toFixed(1).padStart(5) + '%'
const percentile = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(Math.ceil(p * xs.length) - 1, xs.length - 1)]

console.log(`\n${evalSet.length} queries, ${index.count} products\n`)
console.log('  strategy        precision@3   recall@5      MRR   where it runs')
console.log('  ' + '-'.repeat(68))
const where = {
  keyword: 'device, no model',
  semantic: 'device, MiniLM-L6',
  hybrid: 'device, RRF of the two above',
  vectorize: 'Cloudflare, bge-small + Vectorize',
  'vectorize+kw': 'RRF of hosted vectors and local keyword',
}
for (const [name, rows] of Object.entries(runs)) {
  console.log(
    `  ${name.padEnd(16)}${pct(mean(rows, 'p3'))}       ${pct(mean(rows, 'r5'))}     ${pct(mean(rows, 'mrr'))}   ${where[name]}`,
  )
}

if (REMOTE) {
  console.log('\n  latency per query (n = %d, not a like-for-like comparison)', evalSet.length)
  console.log('  ' + '-'.repeat(68))
  const row = (label, xs, note) =>
    console.log(
      `  ${label.padEnd(24)}p50 ${String(percentile(xs, 0.5)).padStart(5)} ms   p95 ${String(percentile(xs, 0.95)).padStart(5)} ms   ${note}`,
    )
  row('on-device embed', timings.device, 'excludes the one-off model download')
  row('hosted, wall clock', timings.hosted, 'includes the round trip from here')
  row('  of which embed', timings.hostedEmbed, 'Workers AI, measured in the worker')
  row('  of which ANN query', timings.hostedQuery, 'Vectorize, measured in the worker')

  console.log('\n  where the two vector backends disagree (reciprocal rank)')
  console.log('  ' + '-'.repeat(68))
  const gaps = perQuery
    .map((r) => ({ ...r, gap: r.vectorize - r.semantic }))
    .filter((r) => Math.abs(r.gap) > 0.15)
    .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))
  if (!gaps.length) console.log('    none beyond noise')
  for (const r of gaps) {
    const winner = r.gap > 0 ? 'hosted' : 'device'
    console.log(
      `    ${winner.padEnd(7)} device ${r.semantic.toFixed(2)}  hosted ${r.vectorize.toFixed(2)}   "${r.q}"`,
    )
  }
}

if (ABLATE) {
  console.log()
  console.log('what the hosted stack changed, one variable at a time (exact cosine)')
  console.log('  ' + '-'.repeat(68))
  const table = await ablate()
  console.log('    model        document text     precision@3   recall@5      MRR')
  for (const r of table) {
    console.log(
      `    ${r.model.padEnd(13)}${r.corpus.padEnd(18)}${pct(mean(r.rows, 'p3'))}       ${pct(mean(r.rows, 'r5'))}     ${pct(mean(r.rows, 'mrr'))}`,
    )
  }
  const at = (m, c) => table.find((r) => r.model === m && r.corpus === c)
  const gain = (a, b) => ((mean(b.rows, 'mrr') - mean(a.rows, 'mrr')) * 100).toFixed(1).padStart(5)
  console.log()
  console.log('    MRR attributable to the document text')
  console.log(`      on MiniLM-L6         ${gain(at('MiniLM-L6', 'specs only'), at('MiniLM-L6', 'prose + facts'))} pts`)
  console.log(`      on bge-small         ${gain(at('bge-small', 'specs only'), at('bge-small', 'prose + facts'))} pts`)
  console.log('    MRR attributable to the model')
  console.log(`      on specs only        ${gain(at('MiniLM-L6', 'specs only'), at('bge-small', 'specs only'))} pts`)
  console.log(`      on prose + facts     ${gain(at('MiniLM-L6', 'prose + facts'), at('bge-small', 'prose + facts'))} pts`)

  /*
   * The hosted stack and one ablation cell are the same model over the same
   * text; the only difference left is Vectorize's approximate search versus an
   * exact scan. Whatever gap remains is the price of the ANN index — and if the
   * two ever diverge sharply, the endpoint is not querying the index this
   * repository builds, which is worth failing loudly over rather than reading
   * two tables and hoping.
   */
  if (REMOTE) {
    const exact = at('bge-small', 'prose + facts')
    const cost = (key, label) =>
      console.log(
        `    ${label.padEnd(14)}exact ${pct(mean(exact.rows, key))}   ANN ${pct(mean(runs.vectorize, key))}   ${((mean(runs.vectorize, key) - mean(exact.rows, key)) * 100).toFixed(1).padStart(5)} pts`,
      )
    console.log()
    console.log('    what the approximate index costs against an exact scan')
    cost('p3', 'precision@3')
    cost('r5', 'recall@5')
    cost('mrr', 'MRR')
    const drift = Math.abs(mean(runs.vectorize, 'mrr') - mean(exact.rows, 'mrr'))
    if (drift > 0.1) {
      console.log(`    WARNING: ${(drift * 100).toFixed(1)} pts apart. The deployed index is probably stale —`)
      console.log('             rebuild and upsert: node scripts/build-vectorize.mjs')
    }
  }
}

const regressions = perQuery.filter((r) => r.semantic < r.keyword)
console.log(`\n  queries where the keyword engine still beats on-device vectors: ${regressions.length}/${evalSet.length}`)
for (const r of regressions) {
  console.log(`    kw ${r.keyword.toFixed(2)}  sem ${r.semantic.toFixed(2)}   "${r.q}"`)
}
console.log()
