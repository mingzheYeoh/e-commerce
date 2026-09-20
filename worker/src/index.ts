/**
 * NEXUS API on Cloudflare Workers.
 *
 * This service exists for the one thing the static site genuinely cannot do:
 * hold a credential. Product data, embeddings and the graph snapshot all ship
 * as static files and answer most queries on-device — this handles the calls
 * that need a server, and nothing else.
 */
import { ask, search, type Env as RagEnv } from './rag'
import { facts, queryOrError } from './graph'
import { converse } from './agent'
import { placeOrder, getOrder, type OrdersEnv } from './orders'

export interface Env extends RagEnv, OrdersEnv {
  ALLOWED_ORIGIN?: string
}

/**
 * A wildcard on a service that writes orders would let any page place them on a
 * visitor's behalf, so the allowed origins are configuration rather than a
 * default. It is a list because the deployed site and the dev server are both
 * real origins and the alternative is editing config to work locally.
 *
 * An unrecognised origin gets the first entry echoed back, which is not its own
 * — the browser then refuses the response, which is the point.
 */
function cors(env: Env, request: Request): Record<string, string> {
  const origin = request.headers.get('origin') ?? ''
  const allowed = (env.ALLOWED_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
  return {
    'access-control-allow-origin': allowed.includes(origin) ? origin : allowed[0],
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    vary: 'origin',
  }
}

const json = (body: unknown, init: ResponseInit & { headers: Record<string, string> }) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  })

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const headers = cors(env, request)
    if (request.method === 'OPTIONS') return new Response(null, { headers })

    const url = new URL(request.url)

    try {
      /* Grounded question answering over the catalogue. */
      if (url.pathname === '/api/ask' && request.method === 'POST') {
        const { question } = (await request.json()) as { question?: string }
        if (typeof question !== 'string' || !question.trim()) {
          return json({ error: 'question is required' }, { status: 400, headers })
        }
        return json(await ask(env, question), { headers })
      }

      /*
       * Retrieval with no model in the loop, so the hosted index can be scored
       * against the same evaluation set as the on-device one.
       */
      if (url.pathname === '/api/search' && request.method === 'GET') {
        const q = (url.searchParams.get('q') ?? '').trim().slice(0, 500)
        if (!q) return json({ error: 'q is required' }, { status: 400, headers })
        // Clamped: topK is a cost, and an unbounded one is a free way to make
        // this endpoint expensive for someone else.
        const k = Math.min(Math.max(Number(url.searchParams.get('k')) || 20, 1), 50)
        return json(await search(env, q, k), { headers })
      }

      /*
       * The shopping assistant: a bounded tool-calling loop. Returns the calls
       * it made alongside the answer, so the reasoning is inspectable rather
       * than a black box.
       */
      if (url.pathname === '/api/chat' && request.method === 'POST') {
        const { question, history } = (await request.json()) as {
          question?: string
          history?: { role: 'user' | 'assistant'; content: string }[]
        }
        if (typeof question !== 'string' || !question.trim()) {
          return json({ error: 'question is required' }, { status: 400, headers })
        }
        return json(await converse(env, question, Array.isArray(history) ? history : []), { headers })
      }

      /*
       * Orders. The browser has already written its own receipt by the time it
       * calls this, so a failure here costs the shareable copy and nothing else.
       */
      if (url.pathname === '/api/orders' && request.method === 'POST') {
        const result = await placeOrder(env, await request.json())
        return json(result.body, { status: result.status, headers })
      }

      if (url.pathname.startsWith('/api/orders/') && request.method === 'GET') {
        const order = await getOrder(env, url.pathname.slice('/api/orders/'.length))
        return order
          ? json(order, { headers })
          : json({ error: 'not found' }, { status: 404, headers })
      }

      /* Structured lookups, answered by the graph without a model in the loop. */
      if (url.pathname === '/api/graph/rivals' && request.method === 'GET') {
        const id = url.searchParams.get('id') ?? ''
        return json({ rivals: await facts.rivals(env, id) }, { headers })
      }

      if (url.pathname === '/api/graph/power' && request.method === 'GET') {
        const id = url.searchParams.get('id') ?? ''
        return json({ chargers: await facts.powerFor(env, id) }, { headers })
      }

      /*
       * Liveness. The graph is checked by actually asking it something.
       *
       * Reporting `graph: true` because an environment variable exists was a
       * half-truth: it stayed true while every query came back empty, which is
       * indistinguishable from a database that is simply not loaded. One round
       * trip costs a moment and removes the ambiguity.
       */
      if (url.pathname === '/api/health') {
        const probe = await queryOrError(env, 'MATCH (n) RETURN count(n) AS nodes')
        return json(
          {
            ok: true,
            ai: Boolean(env.AI),
            vectorize: Boolean(env.VECTORIZE),
            orders: Boolean(env.ORDERS),
            graph: 'rows' in probe,
            graphNodes: 'rows' in probe ? (probe.rows[0]?.nodes ?? 0) : null,
            graphError: 'error' in probe ? probe.error : null,
            // Presence only, never values. "credentials not configured" is
            // otherwise three indistinguishable causes.
            graphSecrets: {
              uri: Boolean(env.NEO4J_URI),
              user: Boolean(env.NEO4J_USER),
              password: Boolean(env.NEO4J_PASSWORD),
            },
          },
          { headers },
        )
      }

      return json({ error: 'not found' }, { status: 404, headers })
    } catch (err) {
      // The message is logged, not returned: internal detail in an error body is
      // how stack traces and binding names end up in someone else's console.
      console.error('unhandled', err)
      return json({ error: 'internal error' }, { status: 500, headers })
    }
  },
}
