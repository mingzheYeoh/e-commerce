/**
 * Workers AI, Vectorize and an ExecutionContext, faked for tests.
 *
 * The embedder is bag-of-words.ts. The index is a Map scored by dot product,
 * so tests can read exactly what was upserted and deleted.
 */
import { DIMS, embed } from './bag-of-words'

export { embed }

export interface FakeAi {
  binding: Ai
  /** Every text the model was asked to embed, in order. */
  texts: string[]
  /** Set to make the next runs fail, the way a Workers AI outage does. */
  fail?: Error
  /** What a chat model was last shown. */
  prompt?: string
}

/**
 * Embeds `text`; for a chat call, answers by citing every [id] it was shown,
 * so a test can see what reached the model.
 */
export function fakeAi(): FakeAi {
  const fake: FakeAi = {
    texts: [],
    binding: {
      run: async (_model: string, input: { text: string[] } | { messages: { content: string }[] }) => {
        if (fake.fail) throw fake.fail
        if ('messages' in input) {
          fake.prompt = input.messages.map((m) => m.content).join('\n')
          const ids = [...fake.prompt.matchAll(/^\[([a-z0-9_-]+)\]/gm)].map((m) => `[${m[1]}]`)
          return { response: `Try ${ids.join(' ')}.` }
        }
        fake.texts.push(...input.text)
        return { data: input.text.map(embed), shape: [input.text.length, DIMS] }
      },
    } as unknown as Ai,
  }
  return fake
}

export interface Entry {
  values: number[]
  metadata?: Record<string, unknown>
}

export interface FakeVectorize {
  binding: VectorizeIndex
  entries: Map<string, Entry>
  /** The topK each query asked for, so tests can see the slack. */
  topKs: number[]
}

export function fakeVectorize(): FakeVectorize {
  const entries = new Map<string, Entry>()
  const topKs: number[] = []
  const binding = {
    async upsert(vectors: { id: string; values: number[]; metadata?: Record<string, unknown> }[]) {
      for (const v of vectors) entries.set(v.id, { values: [...v.values], metadata: v.metadata })
      return { mutationId: 'm' }
    },
    async deleteByIds(ids: string[]) {
      for (const id of ids) entries.delete(id)
      return { mutationId: 'm' }
    },
    async query(vector: number[], opts: { topK?: number; returnMetadata?: unknown } = {}) {
      const topK = opts.topK ?? 5
      topKs.push(topK)
      const matches = [...entries]
        .map(([id, e]) => ({
          id,
          score: e.values.reduce((s, x, i) => s + x * vector[i], 0),
          ...(opts.returnMetadata ? { metadata: e.metadata } : {}),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)
      return { matches, count: matches.length }
    },
  }
  return { binding: binding as unknown as VectorizeIndex, entries, topKs }
}

/** A ctx whose waitUntil work a test can await with `settle()`. */
export function fakeCtx() {
  const pending: Promise<unknown>[] = []
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException: () => {},
  } as unknown as ExecutionContext
  return { ctx, settle: () => Promise.all(pending) }
}
