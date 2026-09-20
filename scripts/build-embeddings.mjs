/**
 * Precomputes a sentence embedding for every product.
 *
 * The model runs locally, here at build time — there is no embeddings API call
 * and therefore no key to hold, rotate or leak. The vectors ship as a static
 * asset, so search costs the visitor one file download and no request per query.
 *
 * Output is Float32 packed into a single binary blob plus a small JSON index,
 * rather than JSON numbers: 45 products x 384 dimensions is 69 KB as raw floats
 * and roughly 350 KB written out as decimal text.
 *
 *   node scripts/build-embeddings.mjs
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'
import { pipeline } from '@huggingface/transformers'

const MODEL = 'Xenova/all-MiniLM-L6-v2'
const OUT_DIR = 'public/media/search'
const SRC = 'src/data/products.ts'

/**
 * Bundles a TS module (resolving the `@/` alias) so Node can import it.
 *
 * `loadProducts` below only needs type-stripping because products.ts imports
 * nothing at runtime; anything with real imports has to be bundled.
 */
async function loadShared(entry) {
  const out = path.join(os.tmpdir(), `nexus-shared-${Date.now()}.mjs`)
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: out,
    alias: { '@': path.join(process.cwd(), 'src') },
    logLevel: 'silent',
  })
  try {
    return await import(pathToFileURL(out).href)
  } finally {
    await fs.rm(out, { force: true })
  }
}

/**
 * Loads the real product array by transpiling the module, not by parsing it.
 *
 * A regex over the source silently returned 33 of 45 products — every block the
 * pattern did not anticipate simply vanished, and twelve products would have
 * been unsearchable with nothing failing. `products.ts` imports only types, so
 * stripping them leaves runnable JavaScript and the data can be imported for
 * real.
 */
async function loadProducts() {
  const js = (await esbuild.transform(await fs.readFile(SRC, 'utf8'), {
    loader: 'ts',
    format: 'esm',
  })).code
  const tmp = path.join(os.tmpdir(), `nexus-products-${Date.now()}.mjs`)
  await fs.writeFile(tmp, js)
  try {
    return (await import(pathToFileURL(tmp).href)).products
  } finally {
    await fs.rm(tmp, { force: true })
  }
}

const { documentFor } = await loadShared('src/lib/passages.ts')
const drafts = await loadProducts()
if (!drafts?.length) throw new Error('loaded no products')
console.log(`products: ${drafts.length}`)

console.log(`loading ${MODEL} …`)
const embed = await pipeline('feature-extraction', MODEL, { dtype: 'q8' })

const docs = drafts.map(documentFor)
// Mean pooling with L2 normalisation, so a dot product is the cosine similarity
// and the browser never has to divide by magnitudes at query time.
const output = await embed(docs, { pooling: 'mean', normalize: true })

const [count, dims] = output.dims
const floats = Float32Array.from(output.data)

await fs.mkdir(OUT_DIR, { recursive: true })
await fs.writeFile(path.join(OUT_DIR, 'products.bin'), Buffer.from(floats.buffer))
await fs.writeFile(
  path.join(OUT_DIR, 'products.json'),
  JSON.stringify({ model: MODEL, dims, count, slugs: drafts.map((d) => d.id) }, null, 2) + '\n',
)

console.log(
  `wrote ${count} x ${dims} floats -> ${OUT_DIR}/products.bin (${(floats.byteLength / 1024).toFixed(1)} KB)`,
)
