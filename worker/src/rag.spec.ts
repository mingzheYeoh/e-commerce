import { describe, it, expect, beforeEach } from 'vitest'
import { memoryD1, type MemoryD1 } from '../test/d1-memory'
import { embed, fakeAi, fakeVectorize, type FakeAi, type FakeVectorize } from '../test/ai-memory'
import { passageFor } from '../../src/lib/passages'
import { ask, search, type Env } from './rag'
import { runTool } from './tools'

/**
 * Retrieval checked against D1. The index here holds four products; only the
 * two that are published by an active merchant may ever reach an answer.
 * No Neo4j credentials are bound, so the graph answers nothing — which is
 * also what proves the tools no longer need it to find a product.
 */
const PRODUCTS = [
  // id, merchant, status, title, specs
  ['prd_studio', 'mch_live', 'published', 'Studio One Monitor Headphones', '40 hours playback'],
  ['prd_arc', 'mch_live', 'published', 'Arc Travel Headphones', '22 hours playback'],
  ['prd_gone', 'mch_live', 'archived', 'Gone Wireless Headphones', '60 hours playback'],
  ['prd_banned', 'mch_suspended', 'published', 'Banned Noise Headphones', '80 hours playback'],
] as const

let mem: MemoryD1
let ai: FakeAi
let vec: FakeVectorize
let env: Env

beforeEach(async () => {
  mem = memoryD1()
  ai = fakeAi()
  vec = fakeVectorize()
  env = { ORDERS: mem.db, AI: ai.binding, VECTORIZE: vec.binding }
  for (const [id, status] of [['mch_live', 'active'], ['mch_suspended', 'suspended']]) {
    mem.raw
      .prepare(`INSERT INTO merchants (id, slug, name, settlement_currency, status) VALUES (?, ?, ?, 'USD', ?)`)
      .run(id, id, id, status)
  }
  for (const [id, merchant, status, title, battery] of PRODUCTS) {
    const specs = [{ label: 'Battery', value: battery }]
    const specsSummary = ['Over-ear', 'USB-C', battery]
    mem.raw
      .prepare(
        `INSERT INTO products (id, merchant_id, sku, title, brand, category, price_minor, currency, status, specs, specs_summary)
         VALUES (?, ?, ?, ?, 'Acme', 'audio', 19900, 'USD', ?, ?, ?)`,
      )
      .run(id, merchant, id, title, status, JSON.stringify(specs), JSON.stringify(specsSummary))
    const text = passageFor({ title, brand: 'Acme', category: 'audio', priceMinor: 19900, specsSummary, specs })
    await vec.binding.upsert([
      { id, values: embed(text), metadata: { title, category: 'audio', brand: 'Acme', price: 199, text } },
    ])
  }
})

describe('the query-time liveness check', () => {
  it('drops unpublished and suspended hits from search, keeps live ones in order, and asks for slack', async () => {
    const unfiltered = (await vec.binding.query(embed('headphones'), { topK: 10 })).matches.map((m) => m.id)
    const res = await search(env, 'headphones', 3)
    expect(res.ids).toEqual(unfiltered.filter((id) => id === 'prd_studio' || id === 'prd_arc'))
    expect(res.scores).toHaveLength(2)
    expect(vec.topKs.at(-1)).toBe(3 + 5)
  })

  it('never shows the answering model a product that is not live', async () => {
    const answer = await ask(env, 'which headphones last longest')
    expect(ai.prompt).toContain('[prd_studio]')
    expect(ai.prompt).toContain('[prd_arc]')
    expect(ai.prompt).not.toContain('prd_gone')
    expect(ai.prompt).not.toContain('prd_banned')
    expect(answer.citations.sort()).toEqual(['prd_arc', 'prd_studio'])
  })

  it('leaves search untouched when every hit is live', async () => {
    mem.raw.prepare(`UPDATE products SET status = 'published'`).run()
    mem.raw.prepare(`UPDATE merchants SET status = 'active'`).run()
    const direct = (await vec.binding.query(embed('noise headphones'), { topK: 4 })).matches.map((m) => m.id)
    expect((await search(env, 'noise headphones', 4)).ids).toEqual(direct)
  })
})

describe('the assistant tools, on a product only D1 knows', () => {
  it('compares two products by name, with figures read from their specs', async () => {
    const res = await runTool(env, 'compare_products', { ids: 'Studio One, arc travel' })
    expect(res.ids).toEqual(['prd_studio', 'prd_arc'])
    expect(res.summary).toContain('prd_studio — Studio One Monitor Headphones: price 199, batteryHours 40,')
    expect(res.summary).toContain('chargeWatts not published')
  })

  it('cannot name an archived product or a suspended merchant’s', async () => {
    const res = await runTool(env, 'compare_products', { ids: 'Gone Wireless, Banned Noise' })
    expect(res.ids).toEqual([])
  })

  it('filters on a figure, highest first, and only among live products', async () => {
    const res = await runTool(env, 'filter_products', { property: 'batteryHours', min: 20, category: 'audio' })
    expect(res.ids).toEqual(['prd_studio', 'prd_arc'])
    expect(res.summary.split('\n')[0]).toBe('prd_studio — Studio One Monitor Headphones, batteryHours 40, $199')

    const cheap = await runTool(env, 'filter_products', { property: 'price', max: 100 })
    expect(cheap.ids).toEqual([])
  })

  it('searches without returning what the index still holds but the shop does not sell', async () => {
    const res = await runTool(env, 'search_products', { query: 'headphones' })
    expect(res.ids.sort()).toEqual(['prd_arc', 'prd_studio'])
  })
})
