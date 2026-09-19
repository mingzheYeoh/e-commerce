/**
 * The tools the shopping assistant may call.
 *
 * Every one is backed by the graph or by vector search, and every one returns
 * real product ids. None of them let the model invent a product: it can only
 * select from what a query returned, which is what keeps a conversational
 * assistant from confidently recommending hardware that does not exist.
 *
 * Arguments arrive as JSON the model wrote, so each handler validates rather
 * than trusts — a model will happily pass a string where a number belongs, or a
 * property name that was never offered.
 */
import { facts, query, type GraphEnv } from './graph'
import { embedOne, type Env as RagEnv } from './rag'

export type ToolEnv = RagEnv & GraphEnv

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
 */
async function resolveIds(env: ToolEnv, wanted: string[]): Promise<string[]> {
  const rows = await query(env, 'MATCH (p:Product) RETURN p.id AS id, p.title AS title')
  const catalogue = rows.map((r) => ({
    id: String(r.id),
    id2: squash(String(r.id)),
    title2: squash(String(r.title)),
  }))

  const out: string[] = []
  for (const raw of wanted) {
    const needle = squash(raw)
    if (!needle) continue
    const hit =
      catalogue.find((c) => c.id2 === needle || c.title2 === needle) ??
      catalogue.find((c) => c.title2.startsWith(needle) || c.id2.startsWith(needle)) ??
      catalogue.find((c) => c.title2.includes(needle) || needle.includes(c.id2))
    if (hit && !out.includes(hit.id)) out.push(hit.id)
  }
  return out
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

  const hits = await env.VECTORIZE.query(vector, { topK: 5, returnMetadata: 'all' })
  const rows = hits.matches.map((m) => ({
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
  const property = asString(args.property)
  if (!(NUMERIC as readonly string[]).includes(property)) {
    // Told, not silently ignored: the model can retry with a valid property.
    return { summary: `unknown property "${property}". Valid: ${NUMERIC.join(', ')}`, ids: [] }
  }

  const min = asNumber(args.min)
  const max = asNumber(args.max)
  if (min === null && max === null) return { summary: 'filter_products needs min or max', ids: [] }

  const category = asString(args.category)
  const where = [
    `p.${property} IS NOT NULL`,
    min !== null ? `p.${property} >= $min` : '',
    max !== null ? `p.${property} <= $max` : '',
  ].filter(Boolean)

  // The property is interpolated only after passing the allow-list above; the
  // values are always bound.
  const cypher = category
    ? `MATCH (p:Product)-[:IN_CATEGORY]->(c:Category {id: $category})
       WHERE ${where.join(' AND ')}
       RETURN p.id AS id, p.title AS title, p.${property} AS value, p.price AS price
       ORDER BY p.${property} DESC LIMIT 12`
    : `MATCH (p:Product) WHERE ${where.join(' AND ')}
       RETURN p.id AS id, p.title AS title, p.${property} AS value, p.price AS price
       ORDER BY p.${property} DESC LIMIT 12`

  const rows = await query(env, cypher, { min, max, category })
  return {
    summary: rows.length
      ? rows.map((r) => `${r.id} — ${r.title}, ${property} ${r.value}, $${r.price}`).join('\n')
      : `nothing matched that limit on ${property}`,
    ids: rows.map((r) => String(r.id)),
  }
}

async function compareProducts(env: ToolEnv, args: Record<string, unknown>): Promise<ToolResult> {
  const wanted = asString(args.ids)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 4)
  if (wanted.length < 2) return { summary: 'compare_products needs at least two products', ids: [] }

  const ids = await resolveIds(env, wanted)
  if (ids.length < 2) {
    return { summary: `could not find these in the catalogue: ${wanted.join(', ')}`, ids: [] }
  }

  const rows = await query(
    env,
    `MATCH (p:Product) WHERE p.id IN $ids
     RETURN p.id AS id, p.title AS title, p.price AS price, p.batteryHours AS batteryHours,
            p.chargeWatts AS chargeWatts, p.screenInches AS screenInches,
            p.refreshHz AS refreshHz, p.megapixels AS megapixels, p.storageGb AS storageGb`,
    { ids },
  )
  if (!rows.length) return { summary: `no products found for: ${ids.join(', ')}`, ids: [] }

  /**
   * A missing figure is stated, not omitted.
   *
   * Dropping empty fields let the model read absence as a low value: asked to
   * compare battery life it announced the XPS 16 "has a smaller battery", when
   * in fact Dell does not publish a runtime and the graph holds nothing. Saying
   * "not published" costs a few tokens and removes the invitation to guess.
   */
  const summary = rows
    .map((r) => {
      const stats = Object.entries(r)
        .filter(([k]) => k !== 'id' && k !== 'title')
        .map(([k, v]) => `${k} ${v === null || v === undefined ? 'not published' : v}`)
        .join(', ')
      return `${r.id} — ${r.title}: ${stats}`
    })
    .join('\n')
  return { summary, ids: rows.map((r) => String(r.id)) }
}

async function findAccessories(env: ToolEnv, args: Record<string, unknown>): Promise<ToolResult> {
  const raw = asString(args.id)
  if (!raw) return { summary: 'find_accessories needs a product', ids: [] }
  const [id] = await resolveIds(env, [raw])
  if (!id) return { summary: `no product in the catalogue matches "${raw}"`, ids: [] }

  const [chargers, pairs] = await Promise.all([facts.powerFor(env, id), facts.rivals(env, id, 0)])
  void pairs

  const paired = await query(
    env,
    `MATCH (a:Product)-[:PAIRS_WITH]->(p:Product {id: $id})
     RETURN a.id AS id, a.title AS title, a.price AS price
     ORDER BY a.price LIMIT 6`,
    { id },
  )

  const lines = [
    ...chargers.map((c) => `${c.id} — ${c.title}, charges at ${c.watts}W`),
    ...paired.map((p) => `${p.id} — ${p.title}, $${p.price}`),
  ]
  return {
    summary: lines.length ? lines.join('\n') : `nothing pairs with ${id} in the catalogue`,
    ids: [...chargers, ...paired].map((r) => String(r.id)),
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
