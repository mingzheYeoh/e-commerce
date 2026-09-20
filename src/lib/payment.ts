/**
 * A simulated card gateway.
 *
 * There is no Stripe SDK here and no key, because a real integration could not
 * complete a payment anyway: a PaymentIntent must be created server-side with a
 * secret key, and this store has no such server. The publishable key would have
 * been safe to ship — it is designed to be public — but it only buys card
 * tokenisation, not a charge.
 *
 * Simulating is also the stronger demonstration. Every failure path is
 * reachable, so declines, insufficient funds and expiry can each be shown
 * behaving correctly; a checkout with only a happy path proves much less.
 *
 * The numbers are Stripe's publicly documented test cards, which are a
 * convention rather than a secret.
 */

export type ChargeCode =
  | 'succeeded'
  | 'card_declined'
  | 'insufficient_funds'
  | 'expired_card'
  | 'invalid_number'

export const TEST_CARDS: Record<string, { code: ChargeCode; message: string }> = {
  '4242424242424242': { code: 'succeeded', message: '' },
  '4000000000000002': {
    code: 'card_declined',
    message: 'Your card was declined. Try another card or contact your bank.',
  },
  '4000000000009995': {
    code: 'insufficient_funds',
    message: 'That card has insufficient funds. Try another card.',
  },
  '4000000000000069': {
    code: 'expired_card',
    message: 'That card has expired. Check the expiry date or use another card.',
  },
}

const digitsOf = (input: string) => input.replace(/[\s-]/g, '')

/**
 * The Luhn checksum.
 *
 * It exists so a mistyped digit is caught as a typo rather than sent onward and
 * reported back as a decline — which would send the shopper to their bank over
 * a keyboard slip.
 */
export function luhn(input: string): boolean {
  const digits = digitsOf(input)
  if (!/^\d{12,19}$/.test(digits)) return false

  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

export type ChargeResult =
  | { ok: true; code: 'succeeded' }
  | { ok: false; code: Exclude<ChargeCode, 'succeeded'>; message: string }

export function charge(cardNumber: string): ChargeResult {
  if (!luhn(cardNumber)) {
    return { ok: false, code: 'invalid_number', message: 'That card number is not valid.' }
  }

  const known = TEST_CARDS[digitsOf(cardNumber)]
  if (!known) {
    // Luhn-valid but unrecognised. Declining is the honest default: succeeding
    // would have the demo claim to have taken money it has no way to take.
    return {
      ok: false,
      code: 'card_declined',
      message: 'This demo only accepts the published test cards. Try 4242 4242 4242 4242.',
    }
  }

  return known.code === 'succeeded'
    ? { ok: true, code: 'succeeded' }
    : { ok: false, code: known.code as Exclude<ChargeCode, 'succeeded'>, message: known.message }
}
