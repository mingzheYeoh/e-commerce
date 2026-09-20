/**
 * Order arithmetic, in integer cents throughout.
 *
 * The cart already freezes each line at `unitPriceCents` because floats drift:
 * 899.95 x 3 is 2699.8500000000004. Checkout is where that discipline either
 * holds or quietly breaks, so nothing here converts to dollars — the only
 * division happens in the formatter, once, at the moment of display.
 */

export type ShipMethod = 'standard' | 'express' | 'overnight'

export interface ShipOption {
  label: string
  transit: string
  cents: number
  /** Subtotal at or above which this method costs nothing. */
  freeAbove?: number
}

/**
 * Modelled on mainstream US electronics retail — Best Buy is free over $35,
 * B&H over $49. The threshold sits at $75 because this catalogue's median line
 * is considerably higher, and free shipping that every order qualifies for is
 * not a shipping policy.
 */
export const SHIPPING: Record<ShipMethod, ShipOption> = {
  standard: { label: 'Standard', transit: '3–5 business days', cents: 895, freeAbove: 7500 },
  express: { label: 'Express', transit: '2 business days', cents: 1495 },
  overnight: { label: 'Overnight', transit: 'Next business day', cents: 2995 },
}

/**
 * Destination-based sales tax.
 *
 * The five states that levy none are listed explicitly at 0 rather than left
 * out: an omitted state falls through to the default and would quietly charge
 * tax where none is due. Having them here also gives the UI a visible $0.00
 * case, which proves the rate follows the address rather than being a constant.
 */
export const TAX_RATES: Record<string, number> = {
  CA: 0.0725,
  NY: 0.08875,
  TX: 0.0625,
  WA: 0.065,
  FL: 0.06,
  IL: 0.0625,
  PA: 0.06,
  AZ: 0.056,
  MA: 0.0625,
  GA: 0.04,
  OR: 0,
  DE: 0,
  MT: 0,
  NH: 0,
  AK: 0,
}

const DEFAULT_TAX = 0.06

/** Combined federal and provincial rate, which is what a Canadian invoice shows. */
const CA_RATES: Record<string, number> = {
  AB: 0.05,
  BC: 0.12,
  MB: 0.12,
  NB: 0.15,
  NL: 0.15,
  NS: 0.14,
  NT: 0.05,
  NU: 0.05,
  ON: 0.13,
  PE: 0.15,
  QC: 0.14975,
  SK: 0.11,
  YT: 0.05,
}

export interface TaxPolicy {
  /**
   * What the receipt calls it. Not decoration — a German buyer reading "Sales
   * tax" on a 19% line is reading a line they cannot reconcile with any tax
   * they know, and this is the one number in the order they did not choose.
   */
  label: string
  rate: number
  /** Present where the rate is set below the national level. */
  bySubdivision?: Record<string, number>
}

/**
 * One policy per country this store ships to.
 *
 * Deliberately not a single default rate with exceptions. A flat "6% unless
 * stated" would have quietly charged a Singaporean order six percent of
 * something no Singaporean authority levies, and nothing in the UI would have
 * looked wrong.
 */
export const TAX_POLICY: Record<string, TaxPolicy> = {
  US: { label: 'Sales tax', rate: DEFAULT_TAX, bySubdivision: TAX_RATES },
  CA: { label: 'GST / HST', rate: 0.05, bySubdivision: CA_RATES },
  GB: { label: 'VAT', rate: 0.2 },
  DE: { label: 'VAT', rate: 0.19 },
  FR: { label: 'VAT', rate: 0.2 },
  NL: { label: 'VAT', rate: 0.21 },
  AU: { label: 'GST', rate: 0.1 },
  NZ: { label: 'GST', rate: 0.15 },
  SG: { label: 'GST', rate: 0.09 },
  MY: { label: 'SST', rate: 0.08 },
}

/** What to call the tax line before a country is chosen, and for one we do not know. */
export const taxLabel = (country: string): string =>
  TAX_POLICY[country.trim().toUpperCase()]?.label ?? 'Tax'

/**
 * The rate an address implies, as a fraction.
 *
 * Returns 0 rather than guessing whenever the address is not yet specific
 * enough to answer: no country, or a country whose rate is set per state and
 * no state yet. Charging a placeholder rate under a label that reads
 * "calculated from your address" is a small lie that surfaces as a number the
 * shopper cannot account for.
 */
export function taxRate(country: string, subdivision: string): number {
  const policy = TAX_POLICY[country.trim().toUpperCase()]
  if (!policy) return 0
  if (!policy.bySubdivision) return policy.rate

  const code = subdivision.trim().toUpperCase()
  if (!code) return 0
  return policy.bySubdivision[code] ?? policy.rate
}

export function shippingCents(method: ShipMethod, subtotalCents: number): number {
  if (subtotalCents <= 0) return 0
  const option = SHIPPING[method]
  if (option.freeAbove !== undefined && subtotalCents >= option.freeAbove) return 0
  return option.cents
}

/**
 * Tax on the goods only.
 *
 * Whether delivery is taxable varies by jurisdiction; this store treats it as
 * not, and the function takes the subtotal alone so a caller cannot
 * accidentally decide otherwise by passing a total.
 *
 * Country is required rather than defaulted. `'CA'` alone is California to a
 * US form and Canada to a Canadian one — 7.25% or 5%, from the same two
 * letters — so there is no safe reading of a subdivision without the country
 * it belongs to.
 */
export function taxCents(subtotalCents: number, country: string, subdivision: string): number {
  if (subtotalCents <= 0) return 0
  // One rounding step, on an integer. `subtotal / 100 * rate` in dollars would
  // reintroduce exactly the drift the cents discipline exists to avoid.
  return Math.round(subtotalCents * taxRate(country, subdivision))
}

export interface OrderTotals {
  subtotal: number
  shipping: number
  tax: number
  total: number
}

export function totalCents(input: {
  subtotal: number
  method: ShipMethod
  country: string
  state: string
}): OrderTotals {
  const shipping = shippingCents(input.method, input.subtotal)
  const tax = taxCents(input.subtotal, input.country, input.state)
  return { subtotal: input.subtotal, shipping, tax, total: input.subtotal + shipping + tax }
}
