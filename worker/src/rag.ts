/**
 * Grounded question answering over the product catalogue.
 *
 * Retrieval is hybrid on purpose. Vector search finds products that *sound like*
 * the question; the graph answers the parts that are numeric or relational
 * ("60W or more", "what charges this"). Feeding both to the model means the
 * answer is assembled from facts rather than recalled from pre-training, which
 * is the only reason a model should be anywhere near a product spec.
 *
 * Inference runs on Workers AI, so no third-party key exists in this service at
 * all — the binding is the credential, and it never leaves Cloudflare.
 */
import { facts, type GraphEnv } from './graph'

export interface Env extends GraphEnv {
  AI: Ai
  VECTORIZE: VectorizeIndex
}

const EMBED_MODEL = '@cf/baai/bge-small-en-v1.5'

/**
 * Verified against `wrangler ai models`, not recalled.
 *
 * The first build named `@cf/meta/llama-3.1-8b-instruct`, which Cloudflare
 * retired on 2026-05-30 — the deploy succeeded and every request then failed
 * with AiError 5028. Model identifiers are inventory, not knowledge: check the
 * live catalogue before pinning one.
 *
 * A 70B follows the "refuse when the context does not cover it" instruction far
 * more reliably than a 3B, and grounding is the whole point here. fp8-fast keeps
 * the latency acceptable for a search box.
 */
const CHAT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'

export interface Passage {
  id: string
  title: string
  text: string
}

/** The exact sentence the model is told to use when the context falls short. */
const REFUSAL = "I don't have that in the catalogue."

export interface Answer {
  answer: string
  /** Product ids the answer is built from, after discarding invented ones. */
  citations: string[]
  /** An answer with at least one verifiable citation behind it. */
  grounded: boolean
  /**
   * The model declined because the catalogue does not cover the question.
   *
   * Reported separately from `grounded` because they mean opposite things to a
   * reader: a refusal is the system working, while an ungrounded answer is one
   * to distrust. Collapsing them would label correct behaviour as a failure.
   * Decided here rather than by matching the sentence in the UI, so changing
   * the prompt cannot silently break the distinction.
   */
  refused: boolean
}

/**
 * Numeric constraints, read out of the question before it reaches the model.
 *
 * "under 60W" and "at least 60W" are opposite queries that embed almost
 * identically, so this is pulled out with a pattern and answered by the graph
 * rather than left to similarity.
 */
function numericIntent(question: string): { property: string; value: number } | null {
  const q = question.toLowerCase()
  const table: [RegExp, string][] = [
    [/(\d{2,3})\s*w\b/, 'chargeWatts'],
    [/(\d{1,3})\s*hours?\b/, 'batteryHours'],
    [/([\d,]{4,6})\s*mah/, 'batteryMah'],
    [/(\d{2,3})\s*hz/, 'refreshHz'],
    [/(\d{1,3})\s*mp\b/, 'megapixels'],
  ]
  if (!/\b(at least|more than|over|above|minimum|or more|faster than|longer than)\b/.test(q)) {
    return null
  }
  for (const [re, property] of table) {
    const m = q.match(re)
    if (m) return { property, value: Number(m[1].replace(/,/g, '')) }
  }
  return null
}

/**
 * Pooling must match whatever indexed the corpus.
 *
 * Cloudflare's docs recommend `cls` over the default `mean` for accuracy, but
 * the two are not comparable: embedding the corpus one way and the query the
 * other produces no error and no crash, just quietly worse retrieval. Both
 * sides read this constant.
 */
export const POOLING = 'cls' as const

/** Embeds one string, or returns null if the model gave back an async job. */
export async function embedOne(env: Env, text: string): Promise<number[] | null> {
  const out = await env.AI.run(EMBED_MODEL, { text: [text], pooling: POOLING })
  return 'data' in out ? (out.data?.[0] ?? null) : null
}

/** Vector search over the product passages held in Vectorize. */
async function vectorPassages(env: Env, question: string, topK = 5): Promise<Passage[]> {
  const vector = await embedOne(env, question)
  if (!vector) return []
  const hits = await env.VECTORIZE.query(vector, { topK, returnMetadata: 'all' })
  return hits.matches.map((m) => ({
    id: String(m.id),
    title: String(m.metadata?.title ?? m.id),
    text: String(m.metadata?.text ?? ''),
  }))
}

export interface SearchResult {
  ids: string[]
  scores: number[]
  /** Milliseconds spent embedding the query, and querying the index. */
  timing: { embed: number; query: number }
}

/**
 * Retrieval on its own, with no model in the loop.
 *
 * Exists so the hosted index can be scored against the same 22-query set as the
 * on-device one (scripts/eval-search.mjs --remote). Generation would dominate
 * both the latency and the failure modes, and neither says anything about
 * whether the right products came back.
 *
 * The two timings are separated because they are different bets: the embedding
 * is a model call that a bigger model would slow down, the query is an ANN
 * lookup that more products would slow down. A single number hides which one
 * moved.
 *
 * Workers pin `Date.now()` between I/O operations, so these measure the awaits
 * they bracket and nothing else — which is exactly what is wanted here, and is
 * also why there is no third number for the arithmetic in between.
 */
export async function search(env: Env, question: string, topK = 20): Promise<SearchResult> {
  const t0 = Date.now()
  const vector = await embedOne(env, question)
  const t1 = Date.now()
  if (!vector) return { ids: [], scores: [], timing: { embed: t1 - t0, query: 0 } }

  const hits = await env.VECTORIZE.query(vector, { topK })
  const t2 = Date.now()

  return {
    ids: hits.matches.map((m) => String(m.id)),
    scores: hits.matches.map((m) => m.score),
    timing: { embed: t1 - t0, query: t2 - t1 },
  }
}

/** Graph rows rendered as passages, so the model sees one uniform context. */
async function graphPassages(env: Env, question: string): Promise<Passage[]> {
  const intent = numericIntent(question)
  if (!intent) return []
  const rows = await facts.atLeast(env, intent.property, intent.value)
  return rows.map((r) => ({
    id: String(r.id),
    title: String(r.title),
    text: `${r.title}: ${intent.property} = ${r.value}, price $${r.price}`,
  }))
}

/**
 * The instruction that makes this retrieval-augmented rather than a chatbot
 * with opinions. Two rules carry the weight: answer only from the context, and
 * say so plainly when the context does not cover the question.
 */
const SYSTEM = `You answer questions about a consumer electronics catalogue.

Rules:
- Use ONLY the facts in CONTEXT. Never use knowledge from your training about
  these or any other products, even if you are confident it is correct.
- Cite every product you mention as [id], using the exact id from CONTEXT.
- If CONTEXT does not contain the answer, reply with exactly this sentence and
  nothing else: I don't have that in the catalogue.
  Do not guess, and do not offer a related product as if it answered the
  question.
- Be brief. Two or three sentences.`

/**
 * Discards citations the model invented.
 *
 * A model asked for [id] will sometimes produce a plausible-looking one that was
 * never in the context. Checking them against what was actually retrieved is the
 * difference between a citation and a decoration.
 */
function verifyCitations(text: string, passages: Passage[]): string[] {
  const known = new Set(passages.map((p) => p.id))
  const cited = [...text.matchAll(/\[([a-z0-9-]+)\]/gi)].map((m) => m[1])
  return [...new Set(cited.filter((id) => known.has(id)))]
}

export async function ask(env: Env, question: string): Promise<Answer> {
  const q = question.trim().slice(0, 500)
  if (!q) return { answer: REFUSAL, citations: [], grounded: false, refused: true }

  const [vector, graph] = await Promise.all([vectorPassages(env, q), graphPassages(env, q)])
  // Graph rows first: when a question has a numeric constraint, that is the
  // part the model is least able to work out for itself.
  const passages = [...graph, ...vector].slice(0, 8)

  if (!passages.length) {
    return { answer: REFUSAL, citations: [], grounded: false, refused: true }
  }

  const context = passages.map((p) => `[${p.id}] ${p.title}\n${p.text}`).join('\n\n')

  const result = (await env.AI.run(CHAT_MODEL, {
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `CONTEXT:\n${context}\n\nQUESTION: ${q}` },
    ],
    temperature: 0.1,
    max_tokens: 300,
  })) as { response?: string }

  const answer = (result.response ?? '').trim() || REFUSAL
  const citations = verifyCitations(answer, passages)
  // Compared loosely: the model reproduces the sentence reliably but not always
  // its punctuation.
  const refused = answer.replace(/[.\s]+$/, '').toLowerCase() === REFUSAL.replace(/\.$/, '').toLowerCase()

  return {
    answer,
    citations,
    // An answer that cites nothing verifiable is reported as ungrounded rather
    // than presented with the same confidence as one that does.
    grounded: citations.length > 0,
    refused,
  }
}
