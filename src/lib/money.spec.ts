import { describe, it, expect } from 'vitest'
import { shippingCents, taxCents, totalCents, SHIPPING, TAX_RATES } from './money'

describe('shippingCents', () => {
  it('is free on standard above the threshold, and charged below it', () => {
    // The boundary is the whole rule; $74.99 and $75.00 must land either side.
    expect(shippingCents('standard', 7499)).toBe(895)
    expect(shippingCents('standard', 7500)).toBe(0)
    expect(shippingCents('standard', 129900)).toBe(0)
  })

  it('charges a flat rate for the faster methods regardless of basket size', () => {
    // Free shipping is a standard-delivery promise; a $3,000 order does not
    // earn free overnight.
    expect(shippingCents('express', 500000)).toBe(1495)
    expect(shippingCents('overnight', 500000)).toBe(2995)
  })

  it('charges nothing on an empty basket', () => {
    expect(shippingCents('standard', 0)).toBe(0)
    expect(shippingCents('overnight', 0)).toBe(0)
  })
})

describe('taxCents', () => {
  it('applies the destination rate, not a flat one', () => {
    expect(taxCents(100000, 'CA')).toBe(7250)
    expect(taxCents(100000, 'NY')).toBe(8875)
    expect(taxCents(100000, 'TX')).toBe(6250)
  })

  it('charges nothing in the states that levy no sales tax', () => {
    for (const state of ['OR', 'DE', 'MT', 'NH', 'AK']) {
      expect(taxCents(100000, state), `${state} should be tax free`).toBe(0)
    }
  })

  it('falls back to a default rate for a state it does not list', () => {
    expect(taxCents(100000, 'ZZ')).toBe(6000)
  })

  it('charges nothing until an address gives it a state', () => {
    // Distinct from an unlisted state: no address yet means nothing to tax
    // against, and a default rate under a label reading "calculated from your
    // address" is a number the shopper cannot account for.
    expect(taxCents(100000, '')).toBe(0)
    expect(taxCents(100000, '   ')).toBe(0)
  })

  it('reads the state case-insensitively', () => {
    expect(taxCents(100000, 'ca')).toBe(taxCents(100000, 'CA'))
  })

  it('rounds once, on cents, with no floating point drift', () => {
    // 2699.85 * 0.07250 in dollars is 195.73912500000002. The rule is one
    // rounding step on an integer, which is why the cart holds cents at all.
    expect(taxCents(269985, 'CA')).toBe(19574)
    expect(Number.isInteger(taxCents(269985, 'NY'))).toBe(true)
  })

  it('does not tax shipping', () => {
    // taxCents takes the subtotal only; this asserts the contract rather than
    // an implementation detail, because taxing delivery is a real-world choice
    // this store has made one way.
    const subtotal = 50000
    expect(taxCents(subtotal, 'CA')).toBe(taxCents(subtotal, 'CA'))
    expect(taxCents(subtotal + 1495, 'CA')).not.toBe(taxCents(subtotal, 'CA'))
  })
})

describe('totalCents', () => {
  it('adds subtotal, shipping and tax as integers', () => {
    const t = totalCents({ subtotal: 269900, method: 'express', state: 'CA' })
    expect(t.shipping).toBe(1495)
    expect(t.tax).toBe(19568)
    expect(t.total).toBe(269900 + 1495 + 19568)
    expect(Number.isInteger(t.total)).toBe(true)
  })

  it('survives a basket that would drift as floats', () => {
    // 899.95 x 3 = 2699.8500000000004 in dollars.
    const subtotal = 89995 * 3
    const t = totalCents({ subtotal, method: 'standard', state: 'OR' })
    expect(t.shipping).toBe(0)
    expect(t.tax).toBe(0)
    expect(t.total).toBe(269985)
  })
})

describe('tables', () => {
  it('offers exactly the three methods the UI shows', () => {
    expect(Object.keys(SHIPPING)).toEqual(['standard', 'express', 'overnight'])
  })

  it('keeps the no-tax states at zero rather than omitting them', () => {
    // An omitted state would fall through to the 6% default and quietly charge
    // tax where none is due.
    for (const state of ['OR', 'DE', 'MT', 'NH', 'AK']) {
      expect(TAX_RATES[state]).toBe(0)
    }
  })
})
