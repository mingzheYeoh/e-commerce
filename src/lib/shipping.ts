/**
 * What delivery costs, and how long it takes, per destination.
 *
 * One flat table charged $8.95 to send a laptop to Kuala Lumpur — the same as
 * across town — and offered Overnight to countries no courier reaches
 * overnight. Rates are banded by zone now, and a method that does not exist for
 * a destination is not offered, not offered-then-refused.
 *
 * Zones rather than per-country rates: carriers price this way, and 240
 * countries' worth of rows would be a table nobody maintains, drifting out of
 * date one country at a time.
 */
import { findCountry } from './regions'

export type ShipMethod = 'standard' | 'express' | 'overnight'
export type ZoneId = 'domestic' | 'northAmerica' | 'europe' | 'apac'

export interface ZoneRate {
  cents: number
  transit: string
  /** Subtotal at or above which this method costs nothing, where offered. */
  freeAbove?: number
}

export interface Zone {
  id: ZoneId
  label: string
  /**
   * Only the methods a carrier actually runs to this zone. Overnight exists
   * domestically and nowhere else, which is why this is a partial record and
   * the UI reads its options from here.
   */
  rates: Partial<Record<ShipMethod, ZoneRate>>
}

/** The label is the method's identity; the price and the promise are the zone's. */
export const SHIP_METHODS: Record<ShipMethod, { label: string }> = {
  standard: { label: 'Standard' },
  express: { label: 'Express' },
  overnight: { label: 'Overnight' },
}

/**
 * Free-shipping thresholds rise with the zone.
 *
 * Modelled on mainstream electronics retail: free domestic delivery over $75,
 * and a higher bar abroad because the carrier charge is three times as large.
 * A threshold every order clears is not a shipping policy.
 */
export const ZONES: Record<ZoneId, Zone> = {
  domestic: {
    id: 'domestic',
    label: 'United States',
    rates: {
      standard: { cents: 895, transit: '3–5 business days', freeAbove: 7500 },
      express: { cents: 1495, transit: '2 business days' },
      overnight: { cents: 2995, transit: 'Next business day' },
    },
  },
  northAmerica: {
    id: 'northAmerica',
    label: 'Canada',
    rates: {
      standard: { cents: 1895, transit: '5–8 business days', freeAbove: 15000 },
      express: { cents: 3495, transit: '2–3 business days' },
    },
  },
  europe: {
    id: 'europe',
    label: 'Europe',
    rates: {
      standard: { cents: 2495, transit: '6–10 business days', freeAbove: 20000 },
      express: { cents: 4995, transit: '3–4 business days' },
    },
  },
  apac: {
    id: 'apac',
    label: 'Asia-Pacific',
    rates: {
      standard: { cents: 2695, transit: '7–12 business days', freeAbove: 25000 },
      express: { cents: 5495, transit: '3–5 business days' },
    },
  },
}

const ZONE_BY_COUNTRY: Record<string, ZoneId> = {
  US: 'domestic',
  CA: 'northAmerica',
  GB: 'europe',
  DE: 'europe',
  FR: 'europe',
  NL: 'europe',
  AU: 'apac',
  NZ: 'apac',
  SG: 'apac',
  MY: 'apac',
}

/**
 * Null for a country the store does not ship to.
 *
 * Deliberately not a default zone. Falling back to the cheapest band would
 * quote a price for a service nobody has agreed to provide, and the order
 * endpoint refuses the address anyway — so the two would disagree.
 */
export function zoneFor(country: string): Zone | null {
  const id = ZONE_BY_COUNTRY[country.trim().toUpperCase()]
  return id ? ZONES[id] : null
}

export function rateFor(method: ShipMethod, country: string): ZoneRate | undefined {
  return zoneFor(country)?.rates[method]
}

/** Whether this method is actually run to this destination. */
export const methodAvailable = (method: string, country: string): method is ShipMethod =>
  rateFor(method as ShipMethod, country) !== undefined

/** The methods a shopper may choose, in the order the UI shows them. */
export function methodsFor(country: string): { id: ShipMethod; label: string; rate: ZoneRate }[] {
  const zone = zoneFor(country)
  if (!zone) return []
  return (Object.keys(SHIP_METHODS) as ShipMethod[])
    .filter((id) => zone.rates[id])
    .map((id) => ({ id, label: SHIP_METHODS[id].label, rate: zone.rates[id]! }))
}

/**
 * The cheapest method the destination offers.
 *
 * Used when a change of country strands the current choice — Overnight to
 * Malaysia is not a thing, and silently keeping it would bill for a service
 * that does not exist.
 */
export function defaultMethodFor(country: string): ShipMethod {
  return methodsFor(country)[0]?.id ?? 'standard'
}

export function shippingCents(method: ShipMethod, subtotalCents: number, country: string): number {
  if (subtotalCents <= 0) return 0
  const rate = rateFor(method, country)
  // An unavailable method costs nothing rather than guessing a price. The
  // caller has already been told it is unavailable; charging for it here would
  // turn a UI bug into a billing one.
  if (!rate) return 0
  if (rate.freeAbove !== undefined && subtotalCents >= rate.freeAbove) return 0
  return rate.cents
}

/**
 * Whether the tax line is duty paid at the border rather than sales tax.
 *
 * The store charges the destination's VAT or GST up front, which is what
 * "delivered duty paid" means — and a shopper abroad needs to know they will
 * not be billed again by the courier on the doorstep.
 */
export const isInternational = (country: string): boolean =>
  Boolean(findCountry(country)) && zoneFor(country)?.id !== 'domestic'

/**
 * The domestic free-delivery bar, for the cart's "spend X more" nudge.
 *
 * The cart has no address yet, so there is no zone to read — and promising an
 * international shopper free delivery at $75 would be a promise checkout then
 * breaks. The UI that uses this says "in the US" out loud for that reason.
 */
export const DOMESTIC_FREE_ABOVE = ZONES.domestic.rates.standard!.freeAbove!
