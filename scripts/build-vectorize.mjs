/**
 * Builds the NDJSON payload for Cloudflare Vectorize.
 *
 * The vectors are generated here with the *same* model Workers AI serves
 * (bge-small-en-v1.5), run locally through transformers.js. Indexing therefore
 * costs no API calls and needs no credential — and because both sides use one
 * model and one pooling strategy, a query vector is comparable to the corpus.
 *
 * Pooling is `cls`, matching worker/src/rag.ts. Mixing `cls` and `mean` raises
 * no error; it just makes retrieval quietly worse, which is the hardest kind of
 * bug to notice.
 *
 *   node scripts/build-vectorize.mjs
 *   wrangler vectorize create nexus-products --dimensions=384 --metric=cosine
 *   wrangler vectorize insert nexus-products --file=dist-vectorize/products.ndjson
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'
import { pipeline } from '@huggingface/transformers'

const MODEL = 'Xenova/bge-small-en-v1.5'
const POOLING = 'cls'
const OUT = 'dist-vectorize/products.ndjson'
const ROOT = process.cwd()

async function loadModule(entry) {
  const out = path.join(os.tmpdir(), `nexus-vec-${Date.now()}.mjs`)
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
// Shared with the on-device builder and the evaluation, so the text scored in
// an ablation is the text that actually went into the index.
const { passageFor } = await loadModule('src/lib/passages.ts')

console.log(`embedding ${products.length} products with ${MODEL} (pooling: ${POOLING}) …`)
const embed = await pipeline('feature-extraction', MODEL, { dtype: 'q8' })

const passages = products.map(passageFor)
const output = await embed(passages, { pooling: POOLING, normalize: true })
const [count, dims] = output.dims
const all = Float32Array.from(output.data)

await fs.mkdir(path.dirname(OUT), { recursive: true })
const lines = products.map((p, i) => {
  const values = Array.from(all.slice(i * dims, (i + 1) * dims)).map((v) => Number(v.toFixed(6)))
  return JSON.stringify({
    id: p.id,
    values,
    metadata: { title: p.title, category: p.category, brand: p.brand, price: p.price, text: passages[i] },
  })
})
await fs.writeFile(OUT, lines.join('\n') + '\n')

const bytes = (await fs.stat(OUT)).size
console.log(`wrote ${count} vectors x ${dims} dims -> ${OUT} (${(bytes / 1024).toFixed(0)} KB)`)
console.log('\nnext:')
console.log('  wrangler vectorize create nexus-products --dimensions=384 --metric=cosine')
console.log(`  wrangler vectorize insert nexus-products --file=${OUT}`)
