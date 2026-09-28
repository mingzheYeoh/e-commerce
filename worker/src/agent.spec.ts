import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { memoryD1 } from '../test/d1-memory'
import { converse, chooseModel, DEFAULT_MODEL, EVAL_MODELS } from './agent'
import { categoryIn } from './tools'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The real seeded catalogue: 45 products over five categories. */
function catalogue() {
  const mem = memoryD1()
  const sql = readFileSync(path.join(ROOT, 'worker/migrations/0008-seed-catalogue.sql'), 'utf8')
  for (const stmt of sql.split(/;\r?\n/)) if (stmt.replace(/--[^\n]*/g, '').trim()) mem.raw.prepare(stmt).run()
  const category = (id: string) =>
    (mem.raw.prepare('SELECT category FROM products WHERE id = ?').get(id) as { category: string }).category
  return { db: mem.db, category }
}

/** Replays a model: each call to AI.run returns the next scripted turn. */
function scripted(turns: { response?: string; tool_calls?: unknown }[]) {
  let i = 0
  return { run: async () => turns[Math.min(i++, turns.length - 1)] } as unknown as Ai
}

const filterCall = (args: Record<string, unknown>) => ({
  tool_calls: [{ name: 'filter_products', arguments: args }],
})

describe('categoryIn', () => {
  it('reads the kind of product the shopper named', () => {
    expect(categoryIn('I have $500 budget, I want to buy the phone, any recommend?')).toBe('phones')
    expect(categoryIn('noise cancelling headphones under 300')).toBe('audio')
    expect(categoryIn('a laptop for coding')).toBe('computing')
    expect(categoryIn('mechanical keyboard')).toBe('peripherals')
    expect(categoryIn('a drone with a good camera')).toBe('imaging')
  })

  it('does not read "phones" inside headphones or earphones', () => {
    expect(categoryIn('wireless headphones')).toBe('audio')
    expect(categoryIn('earphones for the gym')).toBe('audio')
  })

  it('stays out of it when the shopper names two kinds, or none', () => {
    expect(categoryIn('a phone and some earbuds')).toBeUndefined()
    expect(categoryIn('anything under $500')).toBeUndefined()
  })
})

describe('the assistant keeps to the kind of product asked for', () => {
  it('fills in the category the model left out of a numeric filter', async () => {
    // The live failure: "$500 budget ... the phone" became price <= 500 with no
    // category, and headphones, keyboards and a webcam came back as phones.
    const { db, category } = catalogue()
    const env = {
      ORDERS: db,
      AI: scripted([filterCall({ property: 'price', max: 500 }), { response: 'Here are the phones.' }]),
    } as unknown as Parameters<typeof converse>[0]

    const reply = await converse(env, 'I have $500 budget, I want to buy the phone, any recommend?')

    expect(reply.citations.length).toBeGreaterThan(0)
    expect(reply.citations.map(category)).toEqual(reply.citations.map(() => 'phones'))
    expect(reply.steps[0]!.result).toMatch(/phones/)
  })

  it('understands a category the model spelled its own way', async () => {
    const { db, category } = catalogue()
    const env = {
      ORDERS: db,
      AI: scripted([filterCall({ property: 'price', max: 1500, category: 'headphones' }), { response: 'ok' }]),
    } as unknown as Parameters<typeof converse>[0]

    const reply = await converse(env, 'what is good under 1500?')

    expect(reply.citations.length).toBeGreaterThan(0)
    expect(new Set(reply.citations.map(category))).toEqual(new Set(['audio']))
  })

  it('leaves a question that names no kind of product across the whole catalogue', async () => {
    const { db, category } = catalogue()
    const env = {
      ORDERS: db,
      AI: scripted([filterCall({ property: 'price', max: 500 }), { response: 'ok' }]),
    } as unknown as Parameters<typeof converse>[0]

    const reply = await converse(env, 'anything good under $500?')

    expect(new Set(reply.citations.map(category)).size).toBeGreaterThan(1)
  })
})

describe('the cards under an answer', () => {
  it('are the products the answer recommends, when it names any', async () => {
    const { db } = catalogue()
    const first = { ORDERS: db, AI: scripted([filterCall({ property: 'price', max: 5000 }), { response: 'x' }]) }
    const all = (await converse(first as unknown as Parameters<typeof converse>[0], 'anything?')).citations
    const [a, b] = all

    const env = {
      ORDERS: db,
      AI: scripted([filterCall({ property: 'price', max: 5000 }), { response: `Try [${a}] or [${b}].` }]),
    } as unknown as Parameters<typeof converse>[0]
    expect((await converse(env, 'anything?')).citations).toEqual([a, b])
  })

  it('also count a product the answer names by its title rather than its [id]', async () => {
    // Live: "best laptop under $2000" was answered with two laptops by name,
    // and the cards showed all six computing items, a power bank among them.
    const { db } = catalogue()
    const env = {
      ORDERS: db,
      AI: scripted([
        filterCall({ property: 'price', max: 2000, category: 'computing' }),
        { response: 'The ThinkPad X1 Carbon Gen 14 is a great choice. The Zenbook S14 (2026) is another.' },
      ]),
    } as unknown as Parameters<typeof converse>[0]
    expect((await converse(env, 'best laptop under $2000')).citations).toEqual(['thinkpad-x1-carbon', 'zenbook-s14'])
  })

  it('fall back to everything the tools found when the answer names nothing', async () => {
    const { db } = catalogue()
    const env = {
      ORDERS: db,
      AI: scripted([filterCall({ property: 'price', max: 5000 }), { response: 'Several fit.' }]),
    } as unknown as Parameters<typeof converse>[0]
    expect((await converse(env, 'anything?')).citations.length).toBeGreaterThan(2)
  })
})

describe('choosing the model', () => {
  it('uses the default unless the deployment allows an override from the list', () => {
    expect(chooseModel({}, EVAL_MODELS[1])).toBe(DEFAULT_MODEL)
    expect(chooseModel({ ALLOW_MODEL_OVERRIDE: '1' }, EVAL_MODELS[1])).toBe(EVAL_MODELS[1])
    // Never an arbitrary model name, even where overrides are allowed.
    expect(chooseModel({ ALLOW_MODEL_OVERRIDE: '1' }, '@cf/some/expensive-model')).toBe(DEFAULT_MODEL)
    expect(chooseModel({ ALLOW_MODEL_OVERRIDE: '1' }, undefined)).toBe(DEFAULT_MODEL)
  })
})
