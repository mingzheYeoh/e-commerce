import { describe, it, expect } from 'vitest'
import { luhn, charge, TEST_CARDS } from './payment'

describe('luhn', () => {
  it('accepts the published test numbers', () => {
    for (const number of Object.keys(TEST_CARDS)) {
      expect(luhn(number), `${number} should pass`).toBe(true)
    }
  })

  it('rejects a single mistyped digit', () => {
    // The point of the check: a typo must not reach the gateway looking valid.
    expect(luhn('4242424242424243')).toBe(false)
    expect(luhn('4000000000000003')).toBe(false)
  })

  it('ignores spaces and dashes the way a card field does', () => {
    expect(luhn('4242 4242 4242 4242')).toBe(true)
    expect(luhn('4242-4242-4242-4242')).toBe(true)
  })

  it('rejects anything that is not a card number', () => {
    expect(luhn('')).toBe(false)
    expect(luhn('abcd')).toBe(false)
    expect(luhn('424242')).toBe(false)
  })
})

describe('charge', () => {
  it('succeeds on the success card', () => {
    const r = charge('4242 4242 4242 4242')
    expect(r.ok).toBe(true)
    expect(r.code).toBe('succeeded')
  })

  it('reports each declined outcome distinctly', () => {
    // A shopper whose card was declined needs different advice from one whose
    // card expired, so the reasons cannot collapse into one failure.
    expect(charge('4000000000000002')).toMatchObject({ ok: false, code: 'card_declined' })
    expect(charge('4000000000009995')).toMatchObject({ ok: false, code: 'insufficient_funds' })
    expect(charge('4000000000000069')).toMatchObject({ ok: false, code: 'expired_card' })
  })

  it('gives every outcome a message a shopper can act on', () => {
    for (const number of Object.keys(TEST_CARDS)) {
      const r = charge(number)
      if (!r.ok) expect(r.message.length).toBeGreaterThan(10)
    }
  })

  it('rejects a Luhn-invalid number before deciding anything else', () => {
    // A typo is not a decline: telling someone their bank refused them when
    // they mistyped a digit sends them to the wrong place.
    const r = charge('4242424242424243')
    expect(r).toMatchObject({ ok: false, code: 'invalid_number' })
  })

  it('treats an unknown but valid card as declined rather than succeeding', () => {
    // 4111111111111111 is Luhn-valid and not in the table. Defaulting to
    // success would make the demo claim to have taken money it cannot take.
    const r = charge('4111111111111111')
    expect(r.ok).toBe(false)
  })

  it('does not care about formatting', () => {
    expect(charge('4000-0000-0000-0002').code).toBe('card_declined')
  })
})
