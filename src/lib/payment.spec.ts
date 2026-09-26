import { describe, it, expect } from 'vitest'
import { luhn, charge, TEST_CARDS, cardBrand, cardProblem, chargeCard, settle, CHANNELS } from './payment'

describe('cardBrand', () => {
  it('reads the brand off the prefix', () => {
    expect(cardBrand('4242 4242 4242 4242')).toBe('Visa')
    expect(cardBrand('5555 5555 5555 4444')).toBe('Mastercard')
    expect(cardBrand('2223 0031 2200 3222')).toBe('Mastercard')
    expect(cardBrand('3782 822463 10005')).toBe('Amex')
    expect(cardBrand('3714 496353 98431')).toBe('Amex')
    // Discover is a real brand this store does not take.
    expect(cardBrand('6011 1111 1111 1117')).toBeNull()
    expect(cardBrand('')).toBeNull()
  })
})

describe('cardProblem', () => {
  const now = new Date(2026, 8, 26) // September 2026
  const visa = { number: '4242 4242 4242 4242', expiry: '09/26', cvc: '123' }

  it('accepts a valid card expiring this month', () => {
    expect(cardProblem(visa, now)).toBeNull()
  })

  it('refuses an expiry in the past or not a date', () => {
    expect(cardProblem({ ...visa, expiry: '08/26' }, now)).toMatch(/expired/i)
    expect(cardProblem({ ...visa, expiry: '13/30' }, now)).toMatch(/expiry/i)
    expect(cardProblem({ ...visa, expiry: '' }, now)).toMatch(/expiry/i)
  })

  it('wants four CVC digits on Amex and three elsewhere', () => {
    const amex = { number: '3782 822463 10005', expiry: '12/29', cvc: '123' }
    expect(cardProblem(amex, now)).toMatch(/CVC/)
    expect(cardProblem({ ...amex, cvc: '1234' }, now)).toBeNull()
    expect(cardProblem({ ...visa, cvc: '1234' }, now)).toMatch(/CVC/)
  })

  it('refuses a Luhn-valid card of a brand it does not take', () => {
    expect(cardProblem({ ...visa, number: '6011 1111 1111 1117' }, now)).toMatch(/Visa, Mastercard/)
  })

  it('refuses a length the brand never issues', () => {
    // 15 digits, Luhn-valid, Visa prefix.
    expect(cardProblem({ ...visa, number: '400000000000006' }, now)).toMatch(/number/i)
  })
})

describe('chargeCard', () => {
  const now = new Date(2026, 8, 26)
  const card = (number: string) => ({ number, expiry: '12/29', cvc: '123' })

  it('keeps the published test cards and their outcomes', () => {
    expect(chargeCard(card('4242 4242 4242 4242'), now)).toMatchObject({ ok: true, brand: 'Visa' })
    expect(chargeCard(card('4000 0000 0000 0002'), now)).toMatchObject({ ok: false, code: 'card_declined' })
  })

  it('calls a typo a typo, before anything else', () => {
    expect(chargeCard({ number: '4242424242424243', expiry: '', cvc: '' }, now)).toMatchObject({ code: 'invalid_number' })
  })

  it('refuses an expired date without reaching the card table', () => {
    expect(chargeCard({ ...card('4242 4242 4242 4242'), expiry: '01/20' }, now)).toMatchObject({ ok: false })
  })
})

describe('settle', () => {
  it('approves only an approval, and tells the other three apart', () => {
    expect(settle('approved')).toEqual({ ok: true, code: 'succeeded' })
    const failed = (['declined', 'timeout', 'cancelled'] as const).map((o) => settle(o))
    for (const r of failed) {
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.message).toMatch(/Nothing was charged/)
    }
    expect(new Set(failed.map((r) => r.code)).size).toBe(3)
  })
})

describe('the channel allow-lists', () => {
  it('are names in plain text, one list per method', () => {
    expect(CHANNELS.card).toEqual(['Visa', 'Mastercard', 'Amex'])
    expect(CHANNELS.fpx).toHaveLength(12)
    expect(CHANNELS.fpx).toContain('Maybank2u')
    expect(CHANNELS.ewallet).toEqual(["Touch 'n Go eWallet", 'GrabPay', 'Boost', 'ShopeePay'])
    for (const name of Object.values(CHANNELS).flat()) expect(name).not.toMatch(/[<>/]|http/)
  })
})

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
