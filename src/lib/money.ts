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

export function shippingCents(method: ShipMethod, subtotalCents: number): number {
  if (subtotalCents <= 0) return 0
  const option = SHIPPING[method]
  if (option.freeAbove !== undefined && subtotalCents >= option.freeAbove) return 0
  return option.cents
}

/**
 * Tax on the goods only.
 *
 * Whether delivery is taxable varies by state; this store treats it as not, and
 * the function takes the subtotal alone so a caller cannot accidentally decide
 * otherwise by passing a total.
 */
export function taxCents(subtotalCents: number, state: string): number {
  if (subtotalCents <= 0) return 0

  const code = state.trim().toUpperCase()
  // No state yet is not the same as a state we do not list. Before an address
  // is entered there is nothing to tax against, and charging a default rate
  // while the label reads "calculated from your address" is a small lie that
  // shows up as a number the shopper cannot account for.
  if (!code) return 0

  const rate = TAX_RATES[code] ?? DEFAULT_TAX
  // One rounding step, on an integer. `subtotal / 100 * rate` in dollars would
  // reintroduce exactly the drift the cents discipline exists to avoid.
  return Math.round(subtotalCents * rate)
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
  state: string
}): OrderTotals {
  const shipping = shippingCents(input.method, input.subtotal)
  const tax = taxCents(input.subtotal, input.state)
  return { subtotal: input.subtotal, shipping, tax, total: input.subtotal + shipping + tax }
}
