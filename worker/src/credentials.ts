/**
 * What proves someone is who they say they are.
 *
 * Extracted from auth.ts when staff sign-in arrived: two systems with different
 * rules needed the same primitives, and the alternative was a second copy that
 * drifts. Nothing here knows about customers or merchants — it takes a password
 * and a salt, or it mints a token.
 */

const encoder = new TextEncoder()

export const toB64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes))
export const fromB64 = (text: string): Uint8Array =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0))

/** URL-safe, because these travel in a link people click out of an email. */
export const toB64Url = (bytes: Uint8Array): string =>
  toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/**
 * PBKDF2-HMAC-SHA256, at the highest iteration count this runtime allows.
 *
 * Not bcrypt or argon2: neither exists in the Workers runtime, and shipping a
 * WASM build of one to hash a demo store's passwords is a larger risk surface
 * than the thing it protects. PBKDF2 is the strongest primitive available here
 * natively, which makes the work factor the only real dial.
 *
 * Workers refuses outright above 100,000 in a single call —
 * `NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not
 * supported` — which on its own is below OWASP's figure for this algorithm.
 * There is no configuration for it; it is the platform's ceiling.
 */
export const PBKDF2_ITERATIONS = 100_000

/**
 * Passes of PBKDF2, chained — which is the way past that ceiling.
 *
 * Each pass takes the previous pass's output as its input, so six of them is
 * 600,000 iterations of work an attacker has to repeat for every single guess.
 * That is OWASP's current figure, reached without a WASM KDF. Measured at
 * 139ms against a 30-second CPU budget, so the headroom is in the hundreds of
 * rounds rather than the ones.
 *
 * Stored per user rather than assumed, which is what lets it be raised again:
 * a row hashed at an older setting still verifies, and is re-hashed at the
 * current one the next time its owner signs in — nobody is locked out by a
 * change they did not ask for.
 */
export const KDF_ROUNDS = 6

export async function derive(
  password: string,
  salt: Uint8Array,
  rounds: number,
): Promise<Uint8Array> {
  // One round, with the password itself as the input, reproduces exactly what a
  // single PBKDF2 call used to produce. That is why every row written before
  // this still verifies against `kdf_rounds = 1`.
  let material = encoder.encode(password) as Uint8Array
  for (let i = 0; i < Math.max(1, rounds); i++) {
    const key = await crypto.subtle.importKey('raw', material, 'PBKDF2', false, ['deriveBits'])
    material = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
        key,
        256,
      ),
    )
  }
  return material
}

/**
 * Comparison that takes the same time whatever the answer.
 *
 * `a === b` on secrets leaks their contents one byte at a time to anyone
 * willing to measure, and the measurement is not exotic.
 */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text))
  return toB64(new Uint8Array(digest))
}

export const randomB64 = (bytes: number): string =>
  toB64(crypto.getRandomValues(new Uint8Array(bytes)))
export const randomToken = (): string => toB64Url(crypto.getRandomValues(new Uint8Array(32)))

export const nowIso = (): string => new Date().toISOString()
export const inSeconds = (s: number): string => new Date(Date.now() + s * 1000).toISOString()
export const isPast = (iso: string | null | undefined): boolean =>
  Boolean(iso) && new Date(iso as string).getTime() < Date.now()

/**
 * Per-account backoff, shared implementation.
 *
 * Both customer and staff sign-in use exponential backoff on repeated password
 * failures. A flat lock is either short enough to grind through or long enough
 * to become a way to deny an account's real owner access — and turning "guess
 * wrong five times" into a denial-of-service is the only way to make a flat
 * lock either secure or usable. Doubling from a short base makes a typo cheap
 * and a campaign expensive: after one wrong guess past the threshold, the wait
 * is 60 seconds; after five, it is 15 minutes; unlimited, it would be weeks.
 */
export const LOCKOUT_THRESHOLD = 5
export const BACKOFF_BASE_SECONDS = 60
export const BACKOFF_MAX_SECONDS = 900

export function backoffSeconds(failures: number): number {
  if (failures < LOCKOUT_THRESHOLD) return 0
  const doublings = failures - LOCKOUT_THRESHOLD
  return Math.min(BACKOFF_BASE_SECONDS * 2 ** doublings, BACKOFF_MAX_SECONDS)
}
