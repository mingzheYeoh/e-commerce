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

export interface AgentStep {
  tool: string
  args: Record<string, unknown>
  result: string
}

export interface ChatResponse {
  answer: string
  citations: string[]
  /** The tool calls behind the answer, in order. */
  steps: AgentStep[]
  /** The loop hit its step limit and answered from what it had. */
  truncated: boolean
}

export type ChatResult =
  | { ok: true; data: ChatResponse }
  | { ok: false; reason: 'timeout' | 'offline' | 'error' }

/**
 * The assistant may make several tool calls before answering, each a round trip
 * to the graph or the vector index, so it gets a longer deadline than a single
 * question does.
 */
const CHAT_TIMEOUT_MS = 60_000

export async function chat(
  question: string,
  history: { role: 'user' | 'assistant'; content: string }[] = [],
  signal?: AbortSignal,
): Promise<ChatResult> {
  const deadline = AbortSignal.timeout(CHAT_TIMEOUT_MS)
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline

  try {
    const res = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question, history }),
      signal: combined,
    })
    if (!res.ok) return { ok: false, reason: 'error' }
    return { ok: true, data: (await res.json()) as ChatResponse }
  } catch (err) {
    if (signal?.aborted) return { ok: false, reason: 'error' }
    if (deadline.aborted) return { ok: false, reason: 'timeout' }
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

/* ------------------------------------------------------------------ orders */

export interface OrderRequest {
  id: string
  address: { name: string; email: string; line1: string; city: string; state: string; postal: string }
  method: string
  /** Skus, quantities and finish. Prices are the server's business, not the browser's. */
  lines: { sku: string; qty: number; finish?: string }[]
  paymentCode: string
  currency: string
}

export interface RemoteOrder {
  id: string
  placedAt: string
  /** Masked by the server: a receipt link should not hand out an address book. */
  email: string
  address: { name: string; line1: string; city: string; state: string; postal: string }
  method: string
  currency: string
  totals: { subtotal: number; shipping: number; tax: number; total: number }
  paymentCode: string
  lines: { sku: string; title: string; qty: number; unitPriceCents: number; finish?: string }[]
}

/**
 * Stores an order so it exists somewhere other than the device that placed it.
 *
 * Returns a boolean rather than throwing because the shopper's receipt is
 * already written locally by the time this runs — a database that is down costs
 * the shareable copy of the order, not the order.
 */
export async function saveOrder(order: OrderRequest): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/api/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(order),
      signal: AbortSignal.timeout(10_000),
    })
    // 409 means this id is already stored, which is a success from here.
    return res.ok || res.status === 409
  } catch {
    return false
  }
}

/** Reads an order placed on another device, or in a browser since cleared. */
export async function fetchOrder(id: string): Promise<RemoteOrder | null> {
  try {
    const res = await fetch(`${BASE}/api/orders/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(10_000),
    })
    return res.ok ? ((await res.json()) as RemoteOrder) : null
  } catch {
    return null
  }
}
