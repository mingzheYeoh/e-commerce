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
  // The FPX and e-wallet simulator's refusals. Never sent to the server:
  // like a declined card, they place no order.
  | 'payment_declined'
  | 'timed_out'
  | 'cancelled'

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

/* -------------------------------------------------- methods and channels */

/*
 * What the storefront offers and what the order endpoint accepts, in one
 * place: the worker imports these lists (as it imports money.ts) and refuses a
 * channel that is not on them. Names only — no logos, and nothing here is a
 * link to, or an imitation of, any bank or wallet.
 */

export type PayMethod = 'card' | 'fpx' | 'ewallet'

export const CARD_BRANDS = ['Visa', 'Mastercard', 'Amex'] as const
export type CardBrand = (typeof CARD_BRANDS)[number]

export const FPX_BANKS = [
  'Maybank2u',
  'CIMB Clicks',
  'Public Bank',
  'RHB Now',
  'Hong Leong Connect',
  'AmOnline',
  'Bank Islam',
  'BSN',
  'Affin',
  'Alliance',
  'UOB',
  'OCBC',
] as const

export const EWALLETS = ["Touch 'n Go eWallet", 'GrabPay', 'Boost', 'ShopeePay'] as const

export const CHANNELS: Record<PayMethod, readonly string[]> = {
  card: CARD_BRANDS,
  fpx: FPX_BANKS,
  ewallet: EWALLETS,
}

export const METHOD_LABEL: Record<PayMethod, string> = {
  card: 'Card',
  fpx: 'FPX online banking',
  ewallet: 'E-wallet',
}

/** The brand a number belongs to, by its prefix, or null for one this store does not take. */
export function cardBrand(input: string): CardBrand | null {
  const d = digitsOf(input)
  if (/^4/.test(d)) return 'Visa'
  if (/^3[47]/.test(d)) return 'Amex'
  if (/^5[1-5]/.test(d)) return 'Mastercard'
  const four = Number(d.slice(0, 4))
  if (d.length >= 4 && four >= 2221 && four <= 2720) return 'Mastercard'
  return null
}

const LENGTHS: Record<CardBrand, number[]> = { Visa: [13, 16, 19], Mastercard: [16], Amex: [15] }

export interface CardInput {
  number: string
  expiry: string
  cvc: string
}

/**
 * What is wrong with a card as typed, or null. Checked in the order a shopper
 * would want to hear it: a typo in the number first, then the date, then the CVC.
 */
export function cardProblem(card: CardInput, now = new Date()): string | null {
  if (!luhn(card.number)) return 'That card number is not valid.'
  const brand = cardBrand(card.number)
  if (!brand) return 'This store takes Visa, Mastercard and Amex.'
  if (!LENGTHS[brand].includes(digitsOf(card.number).length)) return 'That card number is not valid.'

  const m = card.expiry.trim().match(/^(\d{2})\s*\/\s*(\d{2})$/)
  const month = m ? Number(m[1]) : 0
  if (!m || month < 1 || month > 12) return 'Enter the expiry as MM/YY.'
  // A card is good through the last day of its expiry month.
  const expires = (2000 + Number(m[2])) * 12 + month
  if (expires < now.getFullYear() * 12 + now.getMonth() + 1) return 'That card has expired.'

  const cvcLength = brand === 'Amex' ? 4 : 3
  if (!new RegExp(`^\\d{${cvcLength}}$`).test(card.cvc.trim())) {
    return `The CVC is ${cvcLength} digits${brand === 'Amex' ? ', on the front of the card' : ''}.`
  }
  return null
}

/**
 * The card path: validate everything the browser can, then the test-card
 * table. The number, date and CVC stop here — only the brand goes onward.
 */
export function chargeCard(card: CardInput, now = new Date()): ChargeResult & { brand?: CardBrand } {
  const problem = cardProblem(card, now)
  if (problem) {
    return luhn(card.number)
      ? { ok: false, code: 'card_declined', message: problem }
      : { ok: false, code: 'invalid_number', message: problem }
  }
  return { ...charge(card.number), brand: cardBrand(card.number)! }
}

/** What the simulator screen reported for an FPX or e-wallet payment. */
export type SimOutcome = 'approved' | 'declined' | 'timeout' | 'cancelled'

/** The simulator's answer as a charge result. Only an approval places an order. */
export function settle(outcome: SimOutcome): ChargeResult {
  switch (outcome) {
    case 'approved':
      return { ok: true, code: 'succeeded' }
    case 'declined':
      return { ok: false, code: 'payment_declined', message: 'The payment was declined. Nothing was charged. Try again or choose another method.' }
    case 'timeout':
      return { ok: false, code: 'timed_out', message: 'The payment timed out before it was approved. Nothing was charged. Try again.' }
    default:
      return { ok: false, code: 'cancelled', message: 'Payment cancelled. Nothing was charged.' }
  }
}
