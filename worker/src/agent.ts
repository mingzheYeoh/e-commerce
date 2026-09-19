/**
 * The shopping assistant: a bounded tool-calling loop over the catalogue.
 *
 * The model never answers from its own knowledge of these products. It chooses
 * which tool to call, the tool queries the graph or the vector index, and the
 * answer is written from what came back. That is the whole design — the model
 * supplies language and judgement about *which question to ask*, and the data
 * layer supplies every fact.
 *
 * Three limits keep it honest and affordable:
 *   MAX_STEPS   an agent that can loop forever will, usually on a bad argument
 *   MAX_CHARS   tool output is truncated, because context is the scarce resource
 *   temperature low, since this is retrieval and not creative writing
 */
import { runTool, TOOL_DEFS, type ToolEnv } from './tools'

const MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct'
const MAX_STEPS = 4
const MAX_CHARS = 1200

export interface AgentStep {
  tool: string
  args: Record<string, unknown>
  /** What the tool returned, as the model saw it. */
  result: string
}

export interface AgentReply {
  answer: string
  /** Product ids any tool touched, in call order. */
  citations: string[]
  /** The calls made, so the reasoning is inspectable rather than a black box. */
  steps: AgentStep[]
  /** True when the loop hit MAX_STEPS without the model settling on an answer. */
  truncated: boolean
}

const SYSTEM = `You are a shopping assistant for a consumer electronics store.

You have tools that query the store's catalogue. Use them — you have no reliable
knowledge of these products yourself, and anything you state without a tool
result behind it is a guess.

- When the shopper states a number ("under $500", "at least 60W", "more than 20
  hours"), call filter_products. Do not call search_products for numeric limits:
  search returns only the closest few and will miss products that qualify.
- When the shopper describes a situation or a use case, call search_products.
- Refer to products as [id] using the exact ids the tools returned.
- If the tools return nothing useful, say the catalogue does not cover it.
- A figure reported as "not published" is unknown, not zero and not low. Never
  compare on a figure the catalogue does not have; say it is not published.
- Two or three sentences. Recommend, do not list everything.`

/**
 * Workers AI returns tool calls in either the OpenAI shape or an older flat one,
 * and the published type is an intersection of both. Normalising here keeps that
 * ambiguity out of the loop.
 */
function normaliseCalls(raw: unknown): { name: string; args: unknown }[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((call) => {
      const c = call as { name?: string; arguments?: unknown; function?: { name?: string; arguments?: unknown } }
      const name = c.function?.name ?? c.name
      const args = c.function?.arguments ?? c.arguments
      return name ? { name, args } : null
    })
    .filter((c): c is { name: string; args: unknown } => c !== null)
}

export async function converse(
  env: ToolEnv & { AI: Ai },
  question: string,
  history: { role: 'user' | 'assistant'; content: string }[] = [],
): Promise<AgentReply> {
  const messages: { role: string; content: string }[] = [
    { role: 'system', content: SYSTEM },
    ...history.slice(-6),
    { role: 'user', content: question.trim().slice(0, 500) },
  ]

  const steps: AgentStep[] = []
  const citations: string[] = []

  for (let step = 0; step < MAX_STEPS; step++) {
    const out = (await env.AI.run(MODEL, {
      messages,
      tools: TOOL_DEFS,
      temperature: 0.2,
      max_tokens: 400,
    })) as { response?: string; tool_calls?: unknown }

    const calls = normaliseCalls(out.tool_calls)

    if (!calls.length) {
      const answer = (out.response ?? '').trim()
      return {
        answer: answer || 'The catalogue does not cover that.',
        citations: [...new Set(citations)],
        steps,
        truncated: false,
      }
    }

    // The model's own turn has to be in the transcript, or the next round has no
    // record that it already asked for something.
    messages.push({ role: 'assistant', content: `Calling: ${calls.map((c) => c.name).join(', ')}` })

    for (const call of calls) {
      const result = await runTool(env, call.name, call.args)
      const trimmed = result.summary.slice(0, MAX_CHARS)
      citations.push(...result.ids)
      steps.push({
        tool: call.name,
        args: (typeof call.args === 'string' ? safeParse(call.args) : call.args) as Record<string, unknown>,
        result: trimmed,
      })
      messages.push({ role: 'user', content: `Result of ${call.name}:\n${trimmed}` })
    }
  }

  // Out of steps. Rather than return nothing, ask once more with the tools
  // withheld so the model has to answer from what it already gathered.
  const final = (await env.AI.run(MODEL, {
    messages: [...messages, { role: 'user', content: 'Answer now using only the results above.' }],
    temperature: 0.2,
    max_tokens: 400,
  })) as { response?: string }

  return {
    answer: (final.response ?? '').trim() || 'The catalogue does not cover that.',
    citations: [...new Set(citations)],
    steps,
    truncated: true,
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return { raw: s }
  }
}
