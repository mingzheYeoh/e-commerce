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

/* --------------------------------------------------------------- catalogue */

/**
 * The wire shape of `GET /api/products`, mirroring `CatalogueProduct` from
 * `worker/src/catalogue.ts`.
 *
 * Not the frontend's `Product` type: it carries `merchantId`, which a
 * shopper's view has no use for, and it has no `inStock` — that is derived
 * from `stockCount`, the same way the build-time generator derives it, so
 * there is exactly one place that decides what counts as in stock.
 */
export interface CatalogueProduct {
  id: string
  merchantId: string
  sku: string
  title: string
  brand: string
  category: string
  priceMinor: number
  currency: string
  stockCount: number
  badge: string | null
  rating: number
  reviewCount: number
  specs: { label: string; value: string }[]
  specsSummary: string[]
  colorways: { name: string; hex: string }[]
  media: {
    heroImage: string
    hoverImage?: string
    thumb: string
    gallery: string[]
  }
}

/** Null on any failure; the caller keeps whatever it already had. */
export async function fetchCatalogue(): Promise<CatalogueProduct[] | null> {
  try {
    const res = await fetch(`${BASE}/api/products`, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return null
    return ((await res.json()) as { products: CatalogueProduct[] }).products
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ orders */

/** The delivery address as it travels over the wire, country included. */
export interface ShipAddress {
  name: string
  phone: string
  country: string
  line1: string
  line2: string
  city: string
  /** Empty for countries that have no subdivisions. */
  state: string
  postal: string
}

export interface OrderRequest {
  id: string
  address: ShipAddress & { email: string }
  method: string
  /**
   * Catalogue ids, quantities and finish. Prices are the server's business,
   * not the browser's — and an id is the only thing that names one product,
   * since two merchants may list the same sku.
   */
  lines: { productId: string; qty: number; finish?: string }[]
  paymentCode: string
  currency: string
}

export interface RemoteOrder {
  id: string
  placedAt: string
  /** Masked by the server: a receipt link should not hand out an address book. */
  email: string
  address: ShipAddress
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
      // So the session cookie rides along. It is the only way an order is ever
      // filed to an account — the server reads the cookie, not the payload.
      credentials: 'include',
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

/* ---------------------------------------------------------------- accounts */

export interface Account {
  id: string
  email: string
  name: string
}

export interface AccountOrder {
  id: string
  placedAt: string
  total: number
  currency: string
  paymentCode: string
  itemCount: number
}

export type AuthResult = { ok: true; user: Account } | { ok: false; error: string }

/**
 * Every account call sends credentials, because the session is a cookie this
 * page can neither read nor write — it is HttpOnly, so a script injected into
 * the storefront cannot lift it. The cost is that "am I signed in?" is a
 * request rather than a variable.
 */
const credentialled: RequestInit = { credentials: 'include' }

async function post(path: string, body: unknown): Promise<AuthResult> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...credentialled,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    })
    const data = (await res.json().catch(() => ({}))) as { user?: Account; error?: string }
    if (!res.ok) return { ok: false, error: data.error ?? 'Something went wrong. Try again.' }
    if (!data.user) return { ok: false, error: 'Something went wrong. Try again.' }
    return { ok: true, user: data.user }
  } catch {
    return { ok: false, error: 'Could not reach the server. Check your connection.' }
  }
}

export type RegisterResult =
  | { ok: true; message: string }
  | { ok: false; error: string }

/**
 * Registration does not sign anyone in, and does not say whether the address
 * was already taken.
 *
 * Both follow from the same decision: which of the two happened is told only
 * to the inbox that owns the address. So this returns a message to show, not a
 * user — there is no user yet as far as this browser is allowed to know.
 */
export async function registerAccount(
  name: string,
  email: string,
  password: string,
): Promise<RegisterResult> {
  try {
    const res = await fetch(`${BASE}/api/auth/register`, {
      ...credentialled,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, email, password }),
      signal: AbortSignal.timeout(20_000),
    })
    const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string }
    if (!res.ok) return { ok: false, error: data.error ?? 'Something went wrong. Try again.' }
    return { ok: true, message: data.message ?? 'Check your email to finish signing in.' }
  } catch {
    return { ok: false, error: 'Could not reach the server. Check your connection.' }
  }
}

/**
 * Signing in, with an optional second factor.
 *
 * `mfaRequired` comes back when the password was right and a code is still
 * needed — the form switches to asking for one rather than reporting a
 * failure, because nothing failed.
 */
export type SignInResult =
  | { ok: true; user: Account }
  | { ok: false; error: string; mfaRequired?: boolean }

export async function signIn(
  email: string,
  password: string,
  code?: string,
): Promise<SignInResult> {
  try {
    const res = await fetch(`${BASE}/api/auth/login`, {
      ...credentialled,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, code }),
      signal: AbortSignal.timeout(20_000),
    })
    const data = (await res.json().catch(() => ({}))) as {
      user?: Account
      error?: string
      mfaRequired?: boolean
    }
    if (!res.ok || !data.user) {
      return {
        ok: false,
        error: data.error ?? 'Something went wrong. Try again.',
        mfaRequired: data.mfaRequired,
      }
    }
    return { ok: true, user: data.user }
  } catch {
    return { ok: false, error: 'Could not reach the server. Check your connection.' }
  }
}

/** Redeems the link from a verification email, which also signs the user in. */
export const confirmEmail = (token: string) => post('/api/auth/verify', { token })

/**
 * Asks for a reset link.
 *
 * Returns a message rather than a user, and the same one whether or not the
 * address has an account — whether it does is told to the inbox, not to
 * whoever filled in the form.
 */
export async function requestPasswordReset(email: string): Promise<RegisterResult> {
  try {
    const res = await fetch(`${BASE}/api/auth/forgot`, {
      ...credentialled,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
      signal: AbortSignal.timeout(20_000),
    })
    const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string }
    if (!res.ok) return { ok: false, error: data.error ?? 'Something went wrong. Try again.' }
    return { ok: true, message: data.message ?? 'If that address has an account, a reset link is on its way.' }
  } catch {
    return { ok: false, error: 'Could not reach the server. Check your connection.' }
  }
}

/** Sets the new password from a reset link, and signs them in on this device. */
export const resetPassword = (token: string, password: string) =>
  post('/api/auth/reset', { token, password })

export async function signOut(): Promise<void> {
  try {
    await fetch(`${BASE}/api/auth/logout`, {
      ...credentialled,
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    /* The cookie expires on its own; a failed sign-out is not worth an error. */
  }
}

/** Null for "not signed in" and for "could not ask", which render the same. */
export async function currentAccount(): Promise<Account | null> {
  try {
    const res = await fetch(`${BASE}/api/auth/me`, {
      ...credentialled,
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    return ((await res.json()) as { user: Account | null }).user
  } catch {
    return null
  }
}

/** The signed-in shopper's own orders. Null means the session is gone. */
export async function myOrders(): Promise<AccountOrder[] | null> {
  try {
    const res = await fetch(`${BASE}/api/account/orders`, {
      ...credentialled,
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    return ((await res.json()) as { orders: AccountOrder[] }).orders
  } catch {
    return null
  }
}

/* -------------------------------------------------------- account settings */

export interface AccountSettings {
  user: Account
  /** A requested address waiting for its owner to click the link. */
  pendingEmail: string | null
  twoFactor: boolean
  recoveryCodesLeft: number
  sessions: number
}

export type SettingsResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string }

async function accountPost(path: string, body: unknown): Promise<SettingsResult> {
  try {
    const res = await fetch(`${BASE}/api/account/${path}`, {
      ...credentialled,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) return { ok: false, error: String(data.error ?? 'Something went wrong. Try again.') }
    return { ok: true, data }
  } catch {
    return { ok: false, error: 'Could not reach the server. Check your connection.' }
  }
}

export async function fetchSettings(): Promise<AccountSettings | null> {
  try {
    const res = await fetch(`${BASE}/api/account/settings`, {
      ...credentialled,
      signal: AbortSignal.timeout(10_000),
    })
    return res.ok ? ((await res.json()) as AccountSettings) : null
  } catch {
    return null
  }
}

export const changePassword = (current: string, next: string) =>
  accountPost('password', { current, next })

export const changeEmail = (password: string, email: string) =>
  accountPost('email', { password, email })

export const revokeOtherSessions = () => accountPost('sessions/revoke', {})

export const closeAccount = (password: string) => accountPost('delete', { password })

export const startTwoFactor = (password: string) => accountPost('totp/start', { password })

export const confirmTwoFactor = (code: string) => accountPost('totp/confirm', { code })

export const disableTwoFactor = (password: string) => accountPost('totp/disable', { password })
