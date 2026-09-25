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
import { publishedProducts } from './catalogue'
import { isPhotoKey } from './photos'

/*
 * Re-exported because Cloudflare resolves a Durable Object class by name from
 * the worker's own module exports — it is not enough for the class to exist.
 */
export { IpThrottle } from './throttle'
import {
  register,
  login,
  logout,
  verifyEmail,
  requestPasswordReset,
  resetPassword,
  purgeExpired,
  sessionUser,
  accountOrders,
  accountSettings,
  changePassword,
  requestEmailChange,
  revokeOtherSessions,
  deleteAccount,
  startTotpEnrolment,
  confirmTotpEnrolment,
  disableTotp,
  authDefences,
  guard,
  type AuthEnv,
  type AuthResult,
} from './auth'

export interface Env extends RagEnv, OrdersEnv, AuthEnv {
  ALLOWED_ORIGIN?: string
  /** Product photos the merchant console uploaded. Written only by nexus-console. */
  MEDIA?: R2Bucket
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
const allowedOrigins = (env: Env): string[] =>
  (env.ALLOWED_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)

function cors(env: Env, request: Request): Record<string, string> {
  const origin = request.headers.get('origin') ?? ''
  const allowed = allowedOrigins(env)
  return {
    'access-control-allow-origin': allowed.includes(origin) ? origin : allowed[0],
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    /*
     * Sessions ride a cookie, and a browser will not attach one to a
     * cross-origin request unless the response says this. It is safe here only
     * because the origin above is an exact echo of an allow-listed value —
     * `*` with credentials is refused by every browser, which is the spec
     * stopping exactly the mistake it looks like.
     */
    'access-control-allow-credentials': 'true',
    vary: 'origin',
  }
}

/**
 * Refuses a state-changing request that a browser says came from somewhere
 * else.
 *
 * CORS already stops a page on another origin READING a reply, but it does not
 * stop the request being sent: a cross-site form POST carrying a JSON body is
 * a "simple request" and skips the preflight entirely. That is enough to sign
 * a visitor into an attacker's account without their noticing, and then watch
 * their orders land in it.
 *
 * `Origin` is checked only when present. Every browser sends it on a
 * cross-origin POST, so this is complete against the attack; a server-side
 * client with no Origin at all — curl, a health check, another worker — is not
 * a browser and is not the thing being defended against.
 */
function foreignOrigin(env: Env, request: Request): boolean {
  if (request.method === 'GET' || request.method === 'OPTIONS') return false
  const origin = request.headers.get('origin')
  if (!origin) return false
  return !allowedOrigins(env).includes(origin)
}

const json = (body: unknown, init: ResponseInit & { headers: Record<string, string> }) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  })

/**
 * An auth reply, which may carry a Set-Cookie and a Retry-After.
 *
 * Both are headers rather than body fields on purpose: the session must stay
 * out of reach of the page's own JavaScript, and Retry-After is the answer a
 * client library already knows how to read.
 */
const authJson = (result: AuthResult, headers: Record<string, string>) =>
  json(result.body, {
    status: result.status,
    headers: {
      ...headers,
      ...('cookie' in result && result.cookie ? { 'set-cookie': result.cookie } : {}),
      ...('retryAfter' in result && result.retryAfter
        ? { 'retry-after': String(result.retryAfter) }
        : {}),
    },
  })

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const headers = cors(env, request)
    if (request.method === 'OPTIONS') return new Response(null, { headers })

    if (foreignOrigin(env, request)) {
      return json({ error: 'cross-origin request refused' }, { status: 403, headers })
    }

    const url = new URL(request.url)

    try {
      /* Merchant product photos. Only keys the console mints are served, so the
         bucket cannot be listed or probed through this route. The names are
         random and never reused, which is what makes a year's cache safe. */
      if (url.pathname.startsWith('/media/u/') && request.method === 'GET') {
        const key = url.pathname.slice('/media/u/'.length)
        const object = isPhotoKey(key) && env.MEDIA ? await env.MEDIA.get(key) : null
        if (!object) return new Response('not found', { status: 404 })
        return new Response(object.body, {
          headers: {
            'content-type': 'image/webp',
            'cache-control': 'public, max-age=31536000, immutable',
            // Only the first twelve bytes were checked at upload.
            'x-content-type-options': 'nosniff',
            etag: object.httpEtag,
          },
        })
      }

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

      /* The catalogue. Public by definition, so no session and no tenancy
         predicate — see the note at the top of catalogue.ts. */
      if (url.pathname === '/api/products' && request.method === 'GET') {
        // Every storefront page load asks once. Thirty seconds lets the
        // browser absorb quick reloads while a newly published product still
        // shows up within half a minute. Only the browser honours it: a
        // workers.dev response is not stored at the edge.
        return json(
          { products: await publishedProducts(env) },
          { headers: { ...headers, 'cache-control': 'public, max-age=30' } },
        )
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
       * Orders. The checkout waits for this answer: only a 200 becomes a
       * receipt, and a 409 (sold out) keeps the shopper on the checkout.
       */
      if (url.pathname === '/api/orders' && request.method === 'POST') {
        // Per IP, before anything is read: payment is simulated, so nothing
        // else stops a script placing orders that take real stock.
        const limited = await guard(env, request, 'order')
        if (limited) {
          return json(limited.body, {
            status: 429,
            headers: { ...headers, 'retry-after': String(limited.retryAfter) },
          })
        }
        // Signing in is optional at checkout. When there is a session the order
        // is filed to it, which is the only way it ever joins an account.
        const user = await sessionUser(env, request)
        const result = await placeOrder(env, await request.json(), user?.id ?? null)
        return json(result.body, { status: result.status, headers })
      }

      if (url.pathname.startsWith('/api/orders/') && request.method === 'GET') {
        // The session decides whether delivery and refunds are included: only
        // for the account the order was filed to (see getOrder).
        const user = await sessionUser(env, request)
        const order = await getOrder(env, url.pathname.slice('/api/orders/'.length), user?.id ?? null)
        // Never cached anywhere: the answer depends on who is asking, and it
        // carries a name and an address either way.
        const noStore = { ...headers, 'cache-control': 'private, no-store' }
        return order ? json(order, { headers: noStore }) : json({ error: 'not found' }, { status: 404, headers: noStore })
      }

      /*
       * Accounts.
       *
       * The session is a cookie this service sets and reads; it is never in a
       * response body, so the page cannot leak what it cannot see. Each of
       * these replies may carry a Set-Cookie, which is why they are built here
       * rather than through the plain `json` helper.
       */
      if (url.pathname === '/api/auth/register' && request.method === 'POST') {
        return authJson(await register(env, await request.json(), request), headers)
      }

      if (url.pathname === '/api/auth/login' && request.method === 'POST') {
        return authJson(await login(env, await request.json(), request), headers)
      }

      /*
       * The link from a verification email lands on a page in the storefront,
       * and that page calls this. A GET would be followed by mail scanners and
       * link prefetchers — a one-shot token spent by a security appliance
       * before the recipient has read the message.
       */
      if (url.pathname === '/api/auth/verify' && request.method === 'POST') {
        return authJson(await verifyEmail(env, await request.json()), headers)
      }

      if (url.pathname === '/api/auth/forgot' && request.method === 'POST') {
        return authJson(await requestPasswordReset(env, await request.json(), request), headers)
      }

      if (url.pathname === '/api/auth/reset' && request.method === 'POST') {
        return authJson(await resetPassword(env, await request.json()), headers)
      }

      if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
        return authJson(await logout(env, request), headers)
      }

      /* Who this browser is. 200 with a null user rather than a 401: not being
         signed in is an answer, not a failure, and the header renders off it. */
      if (url.pathname === '/api/auth/me' && request.method === 'GET') {
        return json({ user: await sessionUser(env, request) }, { headers })
      }

      if (url.pathname === '/api/account/orders' && request.method === 'GET') {
        const user = await sessionUser(env, request)
        if (!user) return json({ error: 'not signed in' }, { status: 401, headers })
        return json({ orders: await accountOrders(env, user) }, { headers })
      }

      /*
       * Account settings.
       *
       * Every one of these needs a session AND the current password. A live
       * session says a browser was signed in once; it does not say who is at
       * the keyboard now, and an unlocked laptop is the whole attack.
       */
      if (url.pathname.startsWith('/api/account/') && url.pathname !== '/api/account/orders') {
        const user = await sessionUser(env, request)
        if (!user) return json({ error: 'not signed in' }, { status: 401, headers })

        if (url.pathname === '/api/account/settings' && request.method === 'GET') {
          return json(await accountSettings(env, user), { headers })
        }
        if (request.method === 'POST') {
          const route = url.pathname.slice('/api/account/'.length)
          const payload = () => request.json()

          if (route === 'password') return authJson(await changePassword(env, user, await payload()), headers)
          if (route === 'email') return authJson(await requestEmailChange(env, user, await payload(), request), headers)
          if (route === 'sessions/revoke') return authJson(await revokeOtherSessions(env, user, request), headers)
          if (route === 'delete') return authJson(await deleteAccount(env, user, await payload()), headers)
          if (route === 'totp/start') return authJson(await startTotpEnrolment(env, user, await payload()), headers)
          if (route === 'totp/confirm') return authJson(await confirmTotpEnrolment(env, user, await payload()), headers)
          if (route === 'totp/disable') return authJson(await disableTotp(env, user, await payload()), headers)
        }
        return json({ error: 'not found' }, { status: 404, headers })
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
            /*
             * Whether the account protections are actually bound.
             *
             * An unbound rate limiter allows everything, and a missing mail
             * transport closes registration. Both are silent from the outside
             * — the first looks like a working endpoint and the second like a
             * broken one — so they are reported rather than left to be found.
             */
            auth: authDefences(env),
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

  /**
   * Nightly housekeeping.
   *
   * Expired sessions and spent links were already refused on read, so this
   * changes no behaviour — it stops two tables growing forever. A storefront
   * nobody sweeps ends up with a sessions table that is almost entirely dead
   * keys, which is a cost and a bigger thing to lose in a breach.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      purgeExpired(env)
        .then(({ sessions, tokens, staffSessions }) =>
          console.log(
            `purged ${sessions} expired sessions, ${tokens} expired tokens and ${staffSessions} staff sessions`,
          ),
        )
        .catch((err) => console.error('purge failed', err)),
    )
  },
}
