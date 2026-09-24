/**
 * Semantic product search, running entirely in the visitor's browser.
 *
 * Product vectors are precomputed at build time (scripts/build-embeddings.mjs)
 * and ship as a 67 KB binary. Only the *query* has to be embedded at runtime,
 * which is why the model is here at all — and why it is fetched lazily, on the
 * first search rather than on page load.
 *
 * There is no API key anywhere in this path, because there is no API: the model
 * runs on the device. That also means search keeps working offline once the
 * model is cached, and no shopper's query is sent anywhere.
 *
 * Measured on the 22-query evaluation set in search-eval.json
 * (`node scripts/eval-search.mjs`):
 *
 *   strategy   precision@3   recall@5     MRR
 *   keyword        33.3%       65.0%     58.6%
 *   semantic       40.9%       79.8%     73.3%
 *   hybrid         40.9%       70.7%     72.7%
 *
 * Hybrid no longer earns its place on these numbers. It was added when fusion
 * beat semantic alone; re-measured after the catalogue grew to 45 products it
 * costs 9 points of recall@5 and matches on MRR within the noise of a 22-query
 * set (repeat runs move MRR by ~1 point on identical inputs, because q8
 * quantisation is not bit-identical between runs).
 *
 * It is still here because the aggregate hides the shape: on 7 of 22 queries
 * the keyword engine outranks the embeddings outright — it knows a wedding
 * needs a camera and the model does not — and fusion is what keeps those from
 * collapsing. Whether trading tail robustness for mean recall is the right call
 * is a product decision, and it should be made against the table, not against
 * the memory of an older one.
 *
 * The hosted index (bge-small-en-v1.5 over Vectorize) scores 88.4% MRR on the
 * same set and is what /api/ask and /api/chat retrieve from. It is not used
 * here because this path answers in ~11 ms on-device against ~330 ms over the
 * network, and a search box that stutters is a worse search box.
 */
import { catalogue, findProduct } from '@/stores/catalog'
import { recommend } from './recommend'
import { dot, fuseRanks } from './retrieval'
import type { Product } from '@/types'

const MODEL = 'Xenova/all-MiniLM-L6-v2'
const INDEX_URL = '/media/search/products.json'
const VECTORS_URL = '/media/search/products.bin'

interface Index {
  model: string
  dims: number
  count: number
  slugs: string[]
}

export type SemanticState = 'idle' | 'loading' | 'ready' | 'unavailable'

let state: SemanticState = 'idle'
let index: Index | null = null
let vectors: Float32Array | null = null
let embedder: ((text: string) => Promise<Float32Array>) | null = null
let loading: Promise<boolean> | null = null

export const semanticState = () => state

/**
 * Quantised weights, not full precision.
 *
 * q8 is roughly a quarter of the download. Re-running the evaluation against
 * both showed precision and recall marginally *better* at q8 and MRR marginally
 * worse — all inside the noise of a 22-query set. Paying four times the bytes
 * for that would be indefensible.
 */
async function buildEmbedder() {
  const { pipeline, env } = await import('@huggingface/transformers')
  // Weights come from the Hugging Face CDN and are cached by the browser.
  env.allowLocalModels = false
  const pipe = await pipeline('feature-extraction', MODEL, { dtype: 'q8' })
  return async (text: string) => {
    const out = await pipe([text], { pooling: 'mean', normalize: true })
    return Float32Array.from(out.data as Float32Array)
  }
}

/**
 * Loads the index and the model. Safe to call repeatedly: concurrent callers
 * share one in-flight promise, and a failure is remembered as `unavailable` so
 * a blocked CDN does not retry on every keystroke.
 */
export function ensureReady(): Promise<boolean> {
  if (state === 'ready') return Promise.resolve(true)
  if (state === 'unavailable') return Promise.resolve(false)
  if (loading) return loading

  state = 'loading'
  loading = (async () => {
    try {
      const [meta, buf] = await Promise.all([
        fetch(INDEX_URL).then((r) => r.json() as Promise<Index>),
        fetch(VECTORS_URL).then((r) => r.arrayBuffer()),
      ])
      if (meta.count * meta.dims * 4 !== buf.byteLength) {
        throw new Error('vector file does not match its index — rebuild embeddings')
      }
      index = meta
      vectors = new Float32Array(buf)
      embedder = await buildEmbedder()
      state = 'ready'
      return true
    } catch {
      // Offline, a blocked CDN, or a browser without the required APIs. The
      // keyword engine still answers every query, so search degrades rather
      // than breaks.
      state = 'unavailable'
      return false
    } finally {
      loading = null
    }
  })()
  return loading
}

/** Ranked product ids, most similar first. Empty if the model is not ready. */
export async function semanticRank(query: string): Promise<string[]> {
  if (!(await ensureReady()) || !index || !vectors || !embedder) return []
  const q = await embedder(query)
  return index.slugs
    .map((id, i) => ({ id, score: dot(q, vectors!, i * index!.dims, index!.dims) }))
    .sort((a, b) => b.score - a.score)
    .map((r) => r.id)
}

export interface HybridResult {
  products: Product[]
  /** False when the answer came from the keyword engine alone. */
  semantic: boolean
}

/**
 * The search a shopper actually gets.
 *
 * The keyword engine answers immediately and unconditionally; the model is
 * folded in only once it is ready. A visitor on a slow connection sees results
 * now and better results a moment later, rather than a spinner.
 */
export async function hybridSearch(query: string, limit = 6): Promise<HybridResult> {
  const keyword = recommend(query, catalogue.value.length).items.map((r) => r.product.id)

  // The vectors were built for the build-time snapshot. A product published
  // since has no vector and is found by the keyword list alone, which fusion
  // still ranks; one unpublished since still has a vector and is dropped here,
  // so a stale index can never surface a product the shop no longer sells.
  const semantic = (state === 'ready' ? await semanticRank(query) : []).filter((id) =>
    findProduct(id),
  )
  if (!semantic.length) {
    return { products: keyword.slice(0, limit).map((id) => findProduct(id)!), semantic: false }
  }

  const fused = fuseRanks([keyword, semantic])
    .map((id) => findProduct(id))
    .filter((p): p is Product => p !== undefined)
    .slice(0, limit)
  return { products: fused, semantic: true }
}
