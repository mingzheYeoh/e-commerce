/**
 * Staff fixtures shared by staff-auth.spec.ts and console.spec.ts.
 *
 * Test-only, outside `src/` for the same reason d1-memory.ts is.
 */
import { vi } from 'vitest'
import { memoryD1 } from './d1-memory'
import { registerMerchant, approveMerchant, type StaffResult } from '../src/staff-auth'

/*
 * `tooCommon` reaches Have I Been Pwned for real. Left alone these tests
 * would be slow and network-dependent, and — offline, where the check fails
 * open by design — the breached-password case would go green because nobody
 * answered rather than because the password was refused. The stub answers the
 * way the range endpoint does, for the one password a test plants. Same shape
 * and the same reason as auth.spec.ts.
 */
export const BREACHED = ['password123']

async function sha1Suffix(password: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(password))
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
    .slice(5)
}

/**
 * Replaces `fetch` with the range endpoint's answer. Call from `beforeEach`
 * and undo with `vi.unstubAllGlobals()` in `afterEach`, which runs even when
 * a test fails — so the stub cannot outlive the file that installed it.
 */
export function stubPwned(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      // Nothing else in these modules talks to the network. A request to
      // anywhere else is a mistake worth failing on rather than answering.
      if (!String(url).includes('pwnedpasswords.com')) throw new Error(`unexpected fetch: ${url}`)
      const seen = await Promise.all(BREACHED.map(async (p) => `${await sha1Suffix(p)}:50000`))
      return new Response(seen.join('\r\n'), { status: 200 })
    }),
  )
}

export const env = (db: D1Database) => ({ ORDERS: db })
export const good = { email: 'owner@example.com', name: 'Acme', password: 'Xq7!vurnLp2$wedge' }

/** Registers, approves, and hands back a database with an active merchant. */
export async function activeMerchant() {
  const mem = memoryD1()
  await registerMerchant(env(mem.db), good)
  const id = (mem.raw.prepare(`SELECT id FROM merchants`).get() as { id: string }).id
  const approved = await approveMerchant(env(mem.db), 'stf_platform', id, 'acme')
  if (approved.status !== 200) throw new Error(`fixture approval failed: ${approved.status}`)
  return { ...mem, merchantId: id }
}

/** The `name=value` pair a Set-Cookie header carries, without its attributes. */
export const cookieOf = (setCookie: string | null | undefined): string =>
  String(setCookie ?? '').split(';')[0]

/** A request carrying the cookie a StaffResult set. */
export function withCookie(res: StaffResult): Request {
  return new Request('https://console.test/', { headers: { Cookie: cookieOf(res.headers?.['Set-Cookie']) } })
}
