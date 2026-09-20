import { describe, it, expect } from 'vitest'
import {
  shippingCents,
  methodsFor,
  methodAvailable,
  defaultMethodFor,
  zoneFor,
  rateFor,
  isInternational,
  SHIP_METHODS,
  ZONES,
} from './shipping'
import { COUNTRIES } from './regions'

describe('shippingCents', () => {
  it('is free on domestic standard above the threshold, and charged below it', () => {
    // The boundary is the whole rule; $74.99 and $75.00 must land either side.
    expect(shippingCents('standard', 7499, 'US')).toBe(895)
    expect(shippingCents('standard', 7500, 'US')).toBe(0)
    expect(shippingCents('standard', 129900, 'US')).toBe(0)
  })

  it('charges a flat rate for the faster methods regardless of basket size', () => {
    // Free shipping is a standard-delivery promise; a $3,000 order does not
    // earn free overnight.
    expect(shippingCents('express', 500000, 'US')).toBe(1495)
    expect(shippingCents('overnight', 500000, 'US')).toBe(2995)
  })

  it('charges nothing on an empty basket', () => {
    expect(shippingCents('standard', 0, 'US')).toBe(0)
    expect(shippingCents('overnight', 0, 'US')).toBe(0)
  })

  it('costs more the further it goes', () => {
    /*
     * The bug this module exists to fix. One flat table charged $8.95 to send a
     * laptop across town and $8.95 to send it to Kuala Lumpur.
     */
    const parcel = 5000
    const us = shippingCents('standard', parcel, 'US')
    const ca = shippingCents('standard', parcel, 'CA')
    const gb = shippingCents('standard', parcel, 'GB')
    const my = shippingCents('standard', parcel, 'MY')

    expect(us).toBeLessThan(ca)
    expect(ca).toBeLessThan(gb)
    expect(gb).toBeLessThan(my)
  })

  it('sets the free-delivery bar higher where the carrier costs more', () => {
    // $75 earns free delivery in the US and nowhere else — a threshold every
    // order clears abroad would be giving away the most expensive leg.
    expect(shippingCents('standard', 10000, 'US')).toBe(0)
    expect(shippingCents('standard', 10000, 'MY')).toBe(2695)
    expect(shippingCents('standard', 30000, 'MY')).toBe(0)
  })

  it('charges nothing for a method the destination does not have', () => {
    // Rather than falling back to a domestic price. The order endpoint refuses
    // the combination outright; this only has to avoid inventing a charge.
    expect(shippingCents('overnight', 50000, 'MY')).toBe(0)
  })

  it('charges nothing for a country the store does not ship to', () => {
    expect(shippingCents('standard', 50000, 'ZZ')).toBe(0)
  })
})

describe('what each destination is offered', () => {
  it('offers overnight at home and nowhere else', () => {
    // No carrier runs an overnight service from a US warehouse to Singapore.
    // Offering it and refusing it later is worse than not offering it.
    expect(methodAvailable('overnight', 'US')).toBe(true)
    expect(methodAvailable('overnight', 'MY')).toBe(false)
    expect(methodAvailable('overnight', 'GB')).toBe(false)
  })

  it('offers standard and express everywhere it ships', () => {
    for (const country of COUNTRIES) {
      const ids = methodsFor(country.code).map((m) => m.id)
      expect(ids, `${country.code}`).toContain('standard')
      expect(ids, `${country.code}`).toContain('express')
    }
  })

  it('offers nothing at all to a country it does not ship to', () => {
    expect(methodsFor('ZZ')).toEqual([])
    expect(zoneFor('ZZ')).toBeNull()
    expect(methodAvailable('standard', 'ZZ')).toBe(false)
  })

  it('names a fallback that the destination actually has', () => {
    // Used when a change of country strands the current choice. A fallback
    // that is itself unavailable would just move the problem.
    for (const country of COUNTRIES) {
      const fallback = defaultMethodFor(country.code)
      expect(methodAvailable(fallback, country.code), `${country.code}`).toBe(true)
    }
  })

  it('lists methods in the order the UI shows them', () => {
    expect(methodsFor('US').map((m) => m.id)).toEqual(['standard', 'express', 'overnight'])
    expect(methodsFor('MY').map((m) => m.id)).toEqual(['standard', 'express'])
  })
})

describe('zones', () => {
  it('places every shippable country in a zone', () => {
    /*
     * Two lists edited in different files. A country offered in the address
     * form with no zone here would be quoted nothing for delivery and then
     * refused at the order endpoint — free shipping, right up until checkout.
     */
    for (const country of COUNTRIES) {
      expect(zoneFor(country.code), `${country.code} has no shipping zone`).not.toBeNull()
    }
  })

  it('gives every offered method a price and a promise', () => {
    for (const zone of Object.values(ZONES)) {
      for (const [id, rate] of Object.entries(zone.rates)) {
        expect(rate.cents, `${zone.id}/${id}`).toBeGreaterThan(0)
        expect(rate.transit.length, `${zone.id}/${id}`).toBeGreaterThan(0)
        expect(SHIP_METHODS[id as keyof typeof SHIP_METHODS]).toBeDefined()
      }
    }
  })

  it('reads the country however it was typed', () => {
    expect(rateFor('standard', 'my')).toEqual(rateFor('standard', 'MY'))
    expect(rateFor('standard', ' US ')).toEqual(rateFor('standard', 'US'))
  })

  it('knows which orders cross a border', () => {
    // Drives the "duties are paid at checkout" line, which only makes sense —
    // and only needs saying — on an international order.
    expect(isInternational('US')).toBe(false)
    expect(isInternational('MY')).toBe(true)
    expect(isInternational('ZZ'), 'not a destination at all').toBe(false)
  })
})
