/**
 * Client for the Cloudflare Worker.
 *
 * The storefront is a static site and stays useful without this service, so
 * every call here is written to fail quietly: a timeout, a cold start or a
 * deploy in progress returns a typed failure the UI can render, never an
 * exception that blanks a page.
 */

const BASE = import.meta.env.VITE_API_URL ?? 'https://nexus-api.mingzhe030228.workers.dev'

/** Inference on a 70B model is not instant; a search box's patience is not the bar. */
const TIMEOUT_MS = 30_000

export interface AskResponse {
  answer: string
  /** Product ids the answer was built from. Empty means it declined. */
  citations: string[]
  /** False when nothing in the answer could be traced to a retrieved passage. */
  grounded: boolean
  /**
   * The catalogue does not cover the question and the model said so.
   *
   * Distinct from `!grounded`: a refusal is the system behaving correctly, an
   * ungrounded answer is one to distrust. They look the same in the payload and
   * must not look the same on screen.
   */
  refused: boolean
}

export type AskResult =
  | { ok: true; data: AskResponse }
  | { ok: false; reason: 'timeout' | 'offline' | 'error' }

export async function ask(question: string, signal?: AbortSignal): Promise<AskResult> {
  // Two abort sources: the caller replacing an in-flight question, and our own
  // deadline. Whichever fires first wins.
  const deadline = AbortSignal.timeout(TIMEOUT_MS)
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline

  try {
    const res = await fetch(`${BASE}/api/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question }),
      signal: combined,
    })
    if (!res.ok) return { ok: false, reason: 'error' }
    return { ok: true, data: (await res.json()) as AskResponse }
  } catch (err) {
    if (signal?.aborted) return { ok: false, reason: 'error' }
    if (deadline.aborted) return { ok: false, reason: 'timeout' }
    // fetch throws TypeError for DNS failure, offline, and CORS alike.
    if (err instanceof TypeError) return { ok: false, reason: 'offline' }
    return { ok: false, reason: 'error' }
  }
}

export interface HealthResponse {
  ok: boolean
  ai: boolean
  vectorize: boolean
  graph: boolean
  orders: boolean
}

/**
 * Which backends are actually wired.
 *
 * Surfaced in the UI rather than kept for debugging: the graph is an optional
 * dependency whose absence changes the answers, and a paused free-tier database
 * should say so instead of silently returning less.
 */
export async function health(): Promise<HealthResponse | null> {
  try {
    const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(5000) })
    return res.ok ? ((await res.json()) as HealthResponse) : null
  } catch {
    return null
  }
}
