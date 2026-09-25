import { afterEach, describe, expect, it, vi } from 'vitest'
import { catalogue } from '@/stores/catalog'
import { products } from '@/data/products'
import { documentFor } from './passages'
import { semanticRank } from './semantic'
import { embed } from '../../worker/test/bag-of-words'
import type { Product } from '@/types'

/** Every text the (fake) on-device model was asked to embed. */
const embedded = vi.hoisted(() => [] as string[])

// The model, replaced by a deterministic bag-of-words embedder: no download.
vi.mock('@huggingface/transformers', async () => {
  const { embed } = await import('../../worker/test/bag-of-words')
  return {
    env: {},
    pipeline: async () => async (texts: string[]) => {
      embedded.push(texts[0])
      return { data: Float32Array.from(embed(texts[0])) }
    },
  }
})

const shippedProduct = products[0]
const consoleProduct: Product = {
  ...products[1],
  id: 'prd_7f3a2c',
  title: 'Studio One Monitor Headphones',
  brand: 'Acme Audio Co',
  category: 'audio',
  specsSummary: ['40mm driver', 'closed back', 'coiled cable'],
  specs: [{ label: 'Driver', value: '40mm dynamic' }],
}

// The shipped index: one product, its vector built from the same document text.
vi.stubGlobal(
  'fetch',
  vi.fn(async (url: string) =>
    url.endsWith('.json')
      ? { json: async () => ({ model: 'm', dims: 384, count: 1, slugs: [shippedProduct.id] }) }
      : { arrayBuffer: async () => Float32Array.from(embed(documentFor(shippedProduct))).buffer },
  ),
)

afterEach(() => {
  catalogue.value = products
})

describe('on-device search for a product published after the build', () => {
  it('embeds only the product the shipped file lacks, and ranks it with the rest', async () => {
    catalogue.value = [shippedProduct, consoleProduct]
    const ranked = await semanticRank('studio monitor headphones closed back')
    expect(ranked).toEqual([consoleProduct.id, shippedProduct.id])
    // The query, and the one missing document; never the shipped product.
    expect(embedded).toEqual(['studio monitor headphones closed back', documentFor(consoleProduct)])

    // Cached: a second query embeds only itself.
    await semanticRank('headphones')
    expect(embedded).toHaveLength(3)

    // An edit changes the document, which is embedded again.
    const edited = { ...consoleProduct, specsSummary: ['planar driver', 'open back', 'braided cable'] }
    catalogue.value = [shippedProduct, edited]
    await semanticRank('planar open back')
    expect(embedded.at(-1)).toBe(documentFor(edited))
  })
})
