/**
 * The tools the shopping assistant may call.
 *
 * Every one is backed by D1, vector search or the graph, and every one returns
 * real product ids. None of them let the model invent a product: it can only
 * select from what a query returned, which is what keeps a conversational
 * assistant from confidently recommending hardware that does not exist.
 *
 * Names, comparisons and numeric filters read the live catalogue in D1, with
 * figures pulled from the spec text by the same extractor the graph is built
 * with, so a product a merchant published a minute ago can be found, compared
 * and filtered. Only find_accessories still walks the graph, which is rebuilt
 * offline: a product listed since has no pairing edges until the next rebuild.
 *
 * Arguments arrive as JSON the model wrote, so each handler validates rather
 * than trusts — a model will happily pass a string where a number belongs, or a
 * property name that was never offered.
 */
import { extractFacts } from '../../src/lib/extract-facts'
import { facts, query, type GraphEnv } from './graph'
import { embedOne, SLACK, type Env as RagEnv } from './rag'
import { liveIds, liveProducts } from './catalogue'

export type ToolEnv = RagEnv & GraphEnv

type LiveProduct = Awaited<ReturnType<typeof liveProducts>>[number]

/** Numeric properties a shopper can filter on; anything else is refused. */
const NUMERIC = [
  'chargeWatts',
  'batteryHours',
  'batteryMah',
  'refreshHz',
  'megapixels',
  'storageGb',
  'memoryGb',
  'screenInches',
  'price',
] as const

export interface ToolResult {
  /** Rendered for the model. Kept short: context is the scarce resource. */
  summary: string
  /** Product ids this result touched, so the answer stays traceable. */
  ids: string[]
}

const asNumber = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? n : null
}

const asString = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Lowercase alphanumerics, so "ThinkPad X1 Carbon" and "thinkpadx1carbon" meet. */
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * Resolves whatever the model wrote into a real product id.
 *
 * A tool that only accepts ids is a tool the model cannot call: it has no way to
 * know that the MacBook Pro is `macbook-pro` unless a previous call happened to
 * return it, so it passes the title and the tool answers "not found" about a
 * product sitting right there in the catalogue.
 *
 * Accepting a name is not leniency for its own sake — it is the difference
 * between a tool that works on the first call and one that needs the model to
 * guess an internal convention.
 *
 * Matched against the live catalogue, so an unpublished product or a suspended
 * merchant's is simply not there to be named.
 */
function resolve(catalogue: LiveProduct[], wanted: string[]): LiveProduct[] {
  const keyed = catalogue.map((p) => ({ p, id2: squash(p.id), title2: squash(p.title) }))

  const out: LiveProduct[] = []
  for (const raw of wanted) {
    const needle = squash(raw)
    if (!needle) continue
    const hit =
      keyed.find((c) => c.id2 === needle || c.title2 === needle) ??
      keyed.find((c) => c.title2.startsWith(needle) || c.id2.startsWith(needle)) ??
      keyed.find((c) => c.title2.includes(needle) || needle.includes(c.id2))
    if (hit && !out.includes(hit.p)) out.push(hit.p)
  }
  return out
}

/** Dollars, like the graph's `price` and the index's metadata: it is rendered as `$${price}`. */
const dollars = (p: LiveProduct) => p.priceMinor / 100

/** A numeric figure for one product, or undefined when its specs do not state one. */
function figure(p: LiveProduct, property: (typeof NUMERIC)[number]): number | undefined {
  return property === 'price' ? dollars(p) : extractFacts(p)[property]
}

/* -------------------------------------------------------------- definitions */

/**
 * Annotated rather than inferred.
 *
 * Left to inference, each tool's `properties` becomes its own literal shape and
 * the union does not satisfy the index signature Workers AI expects — the tools
 * differ in which arguments they take, which is the entire point of them.
 */
interface ToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, { type: string; description: string }>
      required: string[]
    }
  }
}

export const TOOL_DEFS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'search_products',
      description:
        'Find products by meaning, for open-ended needs like "something for a noisy commute". Use for descriptions of a situation or use case, not for numeric limits.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What the shopper described, in their own words' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'filter_products',
      description:
        'Find every product meeting a numeric limit, e.g. charging above 60 watts or costing under 500. Use this instead of search whenever the shopper states a number, because search only returns the closest few and would miss the rest.',
      parameters: {
        type: 'object',
        properties: {
          property: {
            type: 'string',
            description: `One of: ${NUMERIC.join(', ')}`,
          },
          min: { type: 'number', description: 'Lowest acceptable value, optional' },
          max: { type: 'number', description: 'Highest acceptable value, optional' },
          category: {
            type: 'string',
            description: 'Optional: phones, audio, computing, peripherals, imaging',
          },
        },
        required: ['property'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compare_products',
      description: 'Put two or more products side by side on their published figures.',
      parameters: {
        type: 'object',
        properties: {
          ids: { type: 'string', description: 'Comma-separated product names or ids, e.g. "XPS 16, ThinkPad X1 Carbon"' },
        },
        required: ['ids'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_accessories',
      description:
        'What pairs with or can charge a given product, following its connector and category rather than guessing.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The product name or id, e.g. "MacBook Pro"' },
        },
        required: ['id'],
      },
    },
  },
]

/* ----------------------------------------------------------------- handlers */

async function searchProducts(env: ToolEnv, args: Record<string, unknown>): Promise<ToolResult> {
  const q = asString(args.query)
  if (!q) return { summary: 'search_products needs a query', ids: [] }

  const vector = await embedOne(env, q)
  if (!vector) return { summary: 'search is unavailable', ids: [] }

  const hits = await env.VECTORIZE.query(vector, { topK: 5 + SLACK, returnMetadata: 'all' })
  // The index may still hold something unpublished or a suspended merchant's.
  const live = await liveIds(env, hits.matches.map((m) => String(m.id)))
  const rows = hits.matches
    .filter((m) => live.has(String(m.id)))
    .slice(0, 5)
    .map((m) => ({
      id: String(m.id),
      title: String(m.metadata?.title ?? m.id),
      price: m.metadata?.price,
    }))
  return {
    summary: rows.length
      ? rows.map((r) => `${r.id} — ${r.title}, $${r.price}`).join('\n')
      : 'no matches',
    ids: rows.map((r) => r.id),
  }
}

async function filterProducts(env: ToolEnv, args: Record<string, unknown>): Promise<ToolResult> {
  const property = asString(args.property) as (typeof NUMERIC)[number]
  if (!NUMERIC.includes(property)) {
    // Told, not silently ignored: the model can retry with a valid property.
    return { summary: `unknown property "${property}". Valid: ${NUMERIC.join(', ')}`, ids: [] }
  }

  const min = asNumber(args.min)
  const max = asNumber(args.max)
  if (min === null && max === null) return { summary: 'filter_products needs min or max', ids: [] }

  const category = asString(args.category)
  // The graph query this replaces: property present, within the bounds,
  // highest first, twelve at most. A figure the specs do not state is absent,
  // not zero, so it never passes a bound.
  const rows = (await liveProducts(env))
    .filter((p) => !category || p.category === category)
    .map((p) => ({ p, value: figure(p, property) }))
    .filter((r): r is { p: LiveProduct; value: number } =>
      r.value !== undefined && (min === null || r.value >= min) && (max === null || r.value <= max),
    )
    .sort((a, b) => b.value - a.value)
    .slice(0, 12)

  return {
    summary: rows.length
      ? rows.map((r) => `${r.p.id} — ${r.p.title}, ${property} ${r.value}, $${dollars(r.p)}`).join('\n')
      : `nothing matched that limit on ${property}`,
    ids: rows.map((r) => r.p.id),
  }
}

/** The figures compare_products lays side by side, in the order the graph query returned them. */
const COMPARED = ['price', 'batteryHours', 'chargeWatts', 'screenInches', 'refreshHz', 'megapixels', 'storageGb'] as const

async function compareProducts(env: ToolEnv, args: Record<string, unknown>): Promise<ToolResult> {
  const wanted = asString(args.ids)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 4)
  if (wanted.length < 2) return { summary: 'compare_products needs at least two products', ids: [] }

  const found = resolve(await liveProducts(env), wanted)
  if (found.length < 2) {
    return { summary: `could not find these in the catalogue: ${wanted.join(', ')}`, ids: [] }
  }

  /**
   * A missing figure is stated, not omitted.
   *
   * Dropping empty fields let the model read absence as a low value: asked to
   * compare battery life it announced the XPS 16 "has a smaller battery", when
   * in fact Dell does not publish a runtime and the graph holds nothing. Saying
   * "not published" costs a few tokens and removes the invitation to guess.
   */
  const summary = found
    .map((p) => {
      const stats = COMPARED.map((k) => `${k} ${figure(p, k) ?? 'not published'}`).join(', ')
      return `${p.id} — ${p.title}: ${stats}`
    })
    .join('\n')
  return { summary, ids: found.map((p) => p.id) }
}

async function findAccessories(env: ToolEnv, args: Record<string, unknown>): Promise<ToolResult> {
  const raw = asString(args.id)
  if (!raw) return { summary: 'find_accessories needs a product', ids: [] }
  const [product] = resolve(await liveProducts(env), [raw])
  if (!product) return { summary: `no product in the catalogue matches "${raw}"`, ids: [] }
  const id = product.id

  // Graph-only: pairing edges come from scripts/build-graph.mjs, so a product
  // listed since the last rebuild has none yet and gets "nothing pairs".
  const [chargers, paired] = await Promise.all([
    facts.powerFor(env, id),
    query(
      env,
      `MATCH (a:Product)-[:PAIRS_WITH]->(p:Product {id: $id})
       RETURN a.id AS id, a.title AS title, a.price AS price
       ORDER BY a.price LIMIT 6`,
      { id },
    ),
  ])
  // The graph is as old as its last rebuild; D1 says what is on sale now.
  const live = await liveIds(env, [...chargers, ...paired].map((r) => String(r.id)))
  const [liveChargers, livePaired] = [chargers, paired].map((rows) => rows.filter((r) => live.has(String(r.id))))

  const lines = [
    ...liveChargers.map((c) => `${c.id} — ${c.title}, charges at ${c.watts}W`),
    ...livePaired.map((p) => `${p.id} — ${p.title}, $${p.price}`),
  ]
  return {
    summary: lines.length ? lines.join('\n') : `nothing pairs with ${id} in the catalogue`,
    ids: [...liveChargers, ...livePaired].map((r) => String(r.id)),
  }
}

/* ------------------------------------------------------------------ dispatch */

const HANDLERS: Record<string, (env: ToolEnv, args: Record<string, unknown>) => Promise<ToolResult>> = {
  search_products: searchProducts,
  filter_products: filterProducts,
  compare_products: compareProducts,
  find_accessories: findAccessories,
}

/**
 * Runs one tool call.
 *
 * A failure is returned as text for the model to read, never thrown: an agent
 * that crashes on a bad argument gives the shopper nothing, while one that is
 * told "unknown property" can correct itself on the next turn.
 */
export async function runTool(
  env: ToolEnv,
  name: string,
  rawArgs: unknown,
): Promise<ToolResult> {
  const handler = HANDLERS[name]
  if (!handler) return { summary: `no such tool: ${name}`, ids: [] }

  let args: Record<string, unknown> = {}
  try {
    args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : ((rawArgs ?? {}) as Record<string, unknown>)
  } catch {
    return { summary: `${name} received arguments that were not valid JSON`, ids: [] }
  }

  try {
    return await handler(env, args)
  } catch (err) {
    return { summary: `${name} failed: ${err instanceof Error ? err.message : 'unknown'}`, ids: [] }
  }
}
