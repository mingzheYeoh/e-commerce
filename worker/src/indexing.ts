/**
 * Keeps the Vectorize index in step with what merchants publish.
 *
 * The index that /api/ask and /api/chat retrieve from is built offline from
 * the build-time snapshot (scripts/build-vectorize.mjs), so a product published
 * from the console did not exist to either until somebody rebuilt it. Now the
 * console writes the entry itself: the same passage (src/lib/passages.ts), the
 * same model and pooling (rag.ts embedOne), the same id and the same metadata.
 * A live entry and an offline one are interchangeable, which is what lets a
 * full rebuild overwrite either without a special case.
 *
 * D1 stays the source of truth. This runs after the response has gone
 * (ctx.waitUntil) and swallows its own failures, so it can neither fail nor
 * slow a merchant's save. What it misses is covered at query time, where every
 * hit is checked against D1 before a model sees it (catalogue.ts liveIds).
 *
 * Photos are not in the passage, so the photo routes never call this.
 */
import { passageFor } from '../../src/lib/passages'
import { embedOne } from './rag'
import { productOf } from './catalogue'
import type { ProductRow } from './tenancy'

export interface IndexEnv {
  AI: Ai
  VECTORIZE: VectorizeIndex
  ORDERS: D1Database
}

/**
 * Exactly the metadata scripts/build-vectorize.mjs writes. rag.ts reads title
 * and text back; tools.ts renders price as `$${price}`, so it is major units
 * (priceMinor / 100), never minor.
 */
function metadataFor(row: ProductRow) {
  const p = productOf(row)
  return { title: p.title, category: p.category, brand: p.brand, price: p.priceMinor / 100, text: passageFor(p) }
}

// ponytail: characters standing in for bge-small's 512-token window. Workers AI
// documents the limit but not what happens past it; transformers.js, which
// embedded the offline set, truncates. The longest seeded passage is ~620
// characters (~200 tokens), so this only cuts a spec table far longer than any
// in the catalogue — and metadata.text, what the model reads, keeps all of it.
const EMBED_CHARS = 1800

/**
 * Brings the index in line with one product write, given the row either side
 * of it: an upsert when it goes on sale or something the passage is made of
 * changes, a delete when it comes off sale, and nothing for a draft.
 *
 * ponytail: two saves racing on one product can still land their upserts out of
 * order, leaving the older text indexed until the next edit. Re-reading the
 * row before the upsert is the fix if merchants ever edit concurrently.
 */
export async function reindex(env: IndexEnv, before: ProductRow, after: ProductRow): Promise<void> {
  try {
    const was = before.status === 'published'
    const is = after.status === 'published'
    if (is) {
      const metadata = metadataFor(after)
      // Compared as what the index would hold, so a stock count does not
      // re-embed and a title or a price does.
      if (was && JSON.stringify(metadata) === JSON.stringify(metadataFor(before))) return
      const values = await embedOne(env, metadata.text.slice(0, EMBED_CHARS))
      if (!values) throw new Error('the embedding came back as an async job')
      // The embed takes ~100ms; an unpublish saved meanwhile has already sent
      // its delete. Ask the row, not the request, whether it is still on sale.
      const now = await env.ORDERS.prepare(`SELECT status FROM products WHERE id = ?1`)
        .bind(after.id)
        .first<{ status: string }>()
      if (now?.status !== 'published') {
        await env.VECTORIZE.deleteByIds([after.id])
        return
      }
      await env.VECTORIZE.upsert([{ id: after.id, values, metadata }])
    } else if (was) {
      await env.VECTORIZE.deleteByIds([after.id])
    }
  } catch (err) {
    // The save has already succeeded. The query-time check keeps an unlisted
    // product out of answers either way; a listed one missing from the index
    // returns the next time its passage changes, or at the next rebuild.
    console.error('reindex failed', { id: after.id, err })
  }
}
