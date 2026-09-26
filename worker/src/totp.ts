/**
 * Time-based one-time passwords (RFC 6238), and the recovery codes that stop
 * a second factor from being a way to lose an account.
 *
 * No dependency. TOTP is HMAC-SHA1 over a counter, and WebCrypto does
 * HMAC-SHA1 — the whole algorithm is the forty lines below. A library here
 * would be a supply-chain surface bigger than the thing it implements.
 *
 * SHA-1 is correct rather than lazy: it is what RFC 6238 specifies and what
 * every authenticator app implements. Its weakness is collision resistance,
 * which an HMAC does not rely on.
 */

/* ------------------------------------------------------------------ base32 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** Base32 without padding, which is the shape authenticator apps expect. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(text: string): Uint8Array {
  // People retype these off a screen, so spaces and case are forgiven and
  // padding is ignored.
  const clean = text.toUpperCase().replace(/[\s=]/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const char of clean) {
    const index = ALPHABET.indexOf(char)
    if (index === -1) throw new Error('bad base32')
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}

/* -------------------------------------------------------------------- totp */

const DIGITS = 6
const PERIOD_SECONDS = 30

/**
 * How far out of step a clock may be.
 *
 * One step either way. Phone clocks drift and people type slowly; zero
 * tolerance produces codes that are correct and rejected, which is
 * indistinguishable from a broken feature. More than one step widens the
 * window an attacker gets to guess in for no real gain.
 */
const DRIFT_STEPS = 1

async function hotp(secret: Uint8Array, counter: number): Promise<string> {
  // The counter goes in as eight bytes, big-endian. Written with a DataView
  // because a 64-bit counter does not fit a JS number's bitwise operators.
  const buffer = new ArrayBuffer(8)
  const view = new DataView(buffer)
  view.setUint32(0, Math.floor(counter / 2 ** 32))
  view.setUint32(4, counter >>> 0)

  const key = await crypto.subtle.importKey(
    'raw',
    secret,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  )
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, buffer))

  // Dynamic truncation, straight from the RFC: the low nibble of the last byte
  // chooses where to read four bytes from.
  const offset = mac[mac.length - 1] & 0x0f
  const binary =
    ((mac[offset] & 0x7f) << 24) |
    (mac[offset + 1] << 16) |
    (mac[offset + 2] << 8) |
    mac[offset + 3]

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0')
}

/**
 * The code this secret shows right now.
 *
 * Exported because it is what makes the implementation checkable against RFC
 * 6238's own test vectors rather than only against itself — a self-consistent
 * TOTP that disagrees with every authenticator app is the failure worth
 * catching, and `verifyTotp` alone cannot catch it.
 */
export async function totpCode(secret: string, atMs: number = Date.now()): Promise<string> {
  return hotp(base32Decode(secret), Math.floor(atMs / 1000 / PERIOD_SECONDS))
}

/** A fresh secret, 20 bytes as the RFC recommends for SHA-1. */
export const newTotpSecret = (): string => base32Encode(crypto.getRandomValues(new Uint8Array(20)))

/**
 * Whether this code is currently valid for this secret.
 *
 * Compared without early exit, for the same reason password hashes are: a
 * comparison that returns as soon as it finds a difference tells anyone
 * measuring how much of the code was right.
 */
export async function verifyTotp(secret: string, code: string): Promise<boolean> {
  const cleaned = code.replace(/\s/g, '')
  if (!/^\d{6}$/.test(cleaned)) return false

  let key: Uint8Array
  try {
    key = base32Decode(secret)
  } catch {
    return false
  }

  const step = Math.floor(Date.now() / 1000 / PERIOD_SECONDS)
  let match = false
  for (let drift = -DRIFT_STEPS; drift <= DRIFT_STEPS; drift++) {
    const expected = await hotp(key, step + drift)
    let diff = 0
    for (let i = 0; i < DIGITS; i++) diff |= expected.charCodeAt(i) ^ cleaned.charCodeAt(i)
    // No early break: every candidate is compared, so the time taken does not
    // depend on which one matched.
    if (diff === 0) match = true
  }
  return match
}

/**
 * The URI an authenticator app reads from a QR code.
 *
 * The issuer appears twice by convention — once as a label prefix and once as
 * a parameter — because different apps read different ones, and an entry that
 * says only an email address is unidentifiable on a phone with thirty of them.
 */
export function otpauthUri(email: string, secret: string, issuer = 'NEXUSOHM'): string {
  const label = encodeURIComponent(`${issuer}:${email}`)
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  })
  return `otpauth://totp/${label}?${params}`
}

/* ---------------------------------------------------------- recovery codes */

/** Enough that losing a phone is survivable, few enough to write on a card. */
export const RECOVERY_CODE_COUNT = 8

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no I, O, 0, 1

/**
 * Codes people copy by hand, so the alphabet drops the characters that get
 * misread — the same one the order ids use.
 */
export function newRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const bytes = crypto.getRandomValues(new Uint8Array(10))
    const body = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')
    return `${body.slice(0, 5)}-${body.slice(5)}`
  })
}

/** Normalised before hashing, so a code typed in lower case still works. */
export const normaliseRecoveryCode = (code: string): string =>
  code.toUpperCase().replace(/[^A-Z0-9]/g, '')
