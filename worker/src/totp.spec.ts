import { describe, it, expect } from 'vitest'
import {
  totpCode,
  verifyTotp,
  newTotpSecret,
  otpauthUri,
  base32Encode,
  base32Decode,
  newRecoveryCodes,
  normaliseRecoveryCode,
  RECOVERY_CODE_COUNT,
} from './totp'

/**
 * RFC 6238's own seed: the ASCII bytes of "12345678901234567890", which is
 * what the specification's test-vector table is computed from.
 */
const RFC_SECRET = base32Encode(new TextEncoder().encode('12345678901234567890'))

describe('TOTP against the specification', () => {
  it('produces the codes RFC 6238 says it should', async () => {
    /*
     * The test that matters. Everything else here only proves the
     * implementation agrees with itself — and a self-consistent TOTP that
     * disagrees with every authenticator app on earth is exactly the failure
     * that would ship unnoticed.
     *
     * Times and expected values are the SHA-1 rows of the RFC's table,
     * truncated to the six digits this store uses.
     */
    expect(await totpCode(RFC_SECRET, 59_000)).toBe('287082')
    expect(await totpCode(RFC_SECRET, 1_111_111_109_000)).toBe('081804')
    expect(await totpCode(RFC_SECRET, 1_234_567_890_000)).toBe('005924')
    expect(await totpCode(RFC_SECRET, 2_000_000_000_000)).toBe('279037')
  })

  it('accepts the code for right now', async () => {
    const secret = newTotpSecret()
    expect(await verifyTotp(secret, await totpCode(secret))).toBe(true)
  })

  it('forgives a clock one step out, either way', async () => {
    // Phone clocks drift and people type slowly. Zero tolerance produces codes
    // that are correct and rejected, which reads as a broken feature.
    const secret = newTotpSecret()
    const now = Date.now()
    expect(await verifyTotp(secret, await totpCode(secret, now - 30_000))).toBe(true)
    expect(await verifyTotp(secret, await totpCode(secret, now + 30_000))).toBe(true)
  })

  it('refuses a code from further out than that', async () => {
    const secret = newTotpSecret()
    expect(await verifyTotp(secret, await totpCode(secret, Date.now() - 120_000))).toBe(false)
  })

  it('refuses anything that is not six digits', async () => {
    const secret = newTotpSecret()
    for (const code of ['', '12345', '1234567', 'abcdef', '12 34 56 78']) {
      expect(await verifyTotp(secret, code), code).toBe(false)
    }
  })

  it('ignores spaces, because that is how the digits are shown', async () => {
    const secret = newTotpSecret()
    const code = await totpCode(secret)
    expect(await verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`)).toBe(true)
  })

  it('refuses rather than throwing on a secret that is not base32', async () => {
    expect(await verifyTotp('not!valid!base32', '000000')).toBe(false)
  })
})

describe('base32', () => {
  it('round-trips arbitrary bytes', () => {
    for (let length = 1; length <= 20; length++) {
      const bytes = crypto.getRandomValues(new Uint8Array(length))
      expect([...base32Decode(base32Encode(bytes))], `${length} bytes`).toEqual([...bytes])
    }
  })

  it('forgives the way people retype a secret off a screen', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(20))
    const encoded = base32Encode(bytes)
    const mangled = encoded.toLowerCase().replace(/(.{4})/g, '$1 ')
    expect([...base32Decode(mangled)]).toEqual([...bytes])
  })
})

describe('the otpauth URI', () => {
  it('names the issuer twice, because apps read different ones', () => {
    // An entry reading only an email address is unidentifiable on a phone with
    // thirty of them.
    const uri = otpauthUri('ada@example.com', 'ABC234')
    expect(uri.startsWith('otpauth://totp/NEXUSOHM%3Aada%40example.com?')).toBe(true)
    expect(uri).toContain('issuer=NEXUSOHM')
    expect(uri).toContain('secret=ABC234')
    expect(uri).toContain('digits=6')
    expect(uri).toContain('period=30')
  })
})

describe('recovery codes', () => {
  it('issues a survivable number of them, all different', () => {
    const codes = newRecoveryCodes()
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT)
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT)
  })

  it('avoids the characters people misread when copying by hand', () => {
    // Same alphabet as the order ids, and for the same reason.
    for (const code of newRecoveryCodes()) {
      expect(code, code).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/)
    }
  })

  it('normalises the ways somebody might type one back', () => {
    const code = newRecoveryCodes()[0]
    const bare = code.replace('-', '')
    expect(normaliseRecoveryCode(code.toLowerCase())).toBe(bare)
    expect(normaliseRecoveryCode(` ${code} `)).toBe(bare)
    expect(normaliseRecoveryCode(code.replace('-', ' '))).toBe(bare)
  })
})
