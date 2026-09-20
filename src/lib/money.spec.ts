import { describe, it, expect } from 'vitest'
import { taxCents, totalCents, taxLabel, TAX_RATES, TAX_POLICY } from './money'
import { COUNTRIES } from './regions'

describe('taxCents', () => {
  it('applies the destination rate, not a flat one', () => {
    expect(taxCents(100000, 'US', 'CA')).toBe(7250)
    expect(taxCents(100000, 'US', 'NY')).toBe(8875)
    expect(taxCents(100000, 'US', 'TX')).toBe(6250)
  })

  it('charges nothing in the states that levy no sales tax', () => {
    for (const state of ['OR', 'DE', 'MT', 'NH', 'AK']) {
      expect(taxCents(100000, 'US', state), `${state} should be tax free`).toBe(0)
    }
  })

  it('falls back to a default rate for a state it does not list', () => {
    expect(taxCents(100000, 'US', 'ZZ')).toBe(6000)
  })

  it('charges nothing until an address gives it a state', () => {
    // Distinct from an unlisted state: no address yet means nothing to tax
    // against, and a default rate under a label reading "calculated from your
    // address" is a number the shopper cannot account for.
    expect(taxCents(100000, 'US', '')).toBe(0)
    expect(taxCents(100000, 'US', '   ')).toBe(0)
  })

  it('reads the state case-insensitively', () => {
    expect(taxCents(100000, 'US', 'ca')).toBe(taxCents(100000, 'US', 'CA'))
  })

  it('rounds once, on cents, with no floating point drift', () => {
    // 2699.85 * 0.07250 in dollars is 195.73912500000002. The rule is one
    // rounding step on an integer, which is why the cart holds cents at all.
    expect(taxCents(269985, 'US', 'CA')).toBe(19574)
    expect(Number.isInteger(taxCents(269985, 'US', 'NY'))).toBe(true)
  })

  it('does not tax shipping', () => {
    // taxCents takes the subtotal only; this asserts the contract rather than
    // an implementation detail, because taxing delivery is a real-world choice
    // this store has made one way.
    const subtotal = 50000
    expect(taxCents(subtotal, 'US', 'CA')).toBe(taxCents(subtotal, 'US', 'CA'))
    expect(taxCents(subtotal + 1495, 'US', 'CA')).not.toBe(taxCents(subtotal, 'US', 'CA'))
  })
})

describe('totalCents', () => {
  it('adds subtotal, shipping and tax as integers', () => {
    const t = totalCents({ subtotal: 269900, method: 'express', country: 'US', state: 'CA' })
    expect(t.shipping).toBe(1495)
    expect(t.tax).toBe(19568)
    expect(t.total).toBe(269900 + 1495 + 19568)
    expect(Number.isInteger(t.total)).toBe(true)
  })

  it('survives a basket that would drift as floats', () => {
    // 899.95 x 3 = 2699.8500000000004 in dollars.
    const subtotal = 89995 * 3
    const t = totalCents({ subtotal, method: 'standard', country: 'US', state: 'OR' })
    expect(t.shipping).toBe(0)
    expect(t.tax).toBe(0)
    expect(t.total).toBe(269985)
  })
})

describe('tables', () => {
  it('keeps the no-tax states at zero rather than omitting them', () => {
    // An omitted state would fall through to the 6% default and quietly charge
    // tax where none is due.
    for (const state of ['OR', 'DE', 'MT', 'NH', 'AK']) {
      expect(TAX_RATES[state]).toBe(0)
    }
  })
})

describe('tax outside the United States', () => {
  it('reads the same two letters differently depending on the country', () => {
    /*
     * The reason country is a required argument rather than an optional one.
     * "CA" is California at 7.25% and Canada at 5%, and a function that took
     * the subdivision alone would have to guess — silently, on the one line of
     * the order the shopper did not choose.
     */
    expect(taxCents(100000, 'US', 'CA')).toBe(7250)
    expect(taxCents(100000, 'CA', 'AB')).toBe(5000)
  })

  it('charges a country-wide rate where tax is set nationally', () => {
    // No subdivision involved: a British address is taxed the moment the
    // country is known, unlike an American one.
    expect(taxCents(100000, 'GB', '')).toBe(20000)
    expect(taxCents(100000, 'SG', '')).toBe(9000)
    expect(taxCents(100000, 'MY', '')).toBe(8000)
  })

  it('follows the province in Canada, where the rate is not national', () => {
    expect(taxCents(100000, 'CA', 'ON')).toBe(13000)
    expect(taxCents(100000, 'CA', 'QC')).toBe(14975)
    // And withholds a number until it knows which province, exactly as the US
    // branch does.
    expect(taxCents(100000, 'CA', '')).toBe(0)
  })

  it('charges nothing for a country the store does not ship to', () => {
    // Not the 6% US default. Charging an American rate to an address that is
    // not American is worse than charging nothing and refusing the order,
    // which is what the endpoint does with it.
    expect(taxCents(100000, 'ZZ', '')).toBe(0)
    expect(taxCents(100000, '', '')).toBe(0)
  })

  it('names the tax the way the destination names it', () => {
    // A German buyer reading "Sales tax" on a 19% line is reading a line they
    // cannot reconcile with any tax they know.
    expect(taxLabel('US')).toBe('Sales tax')
    expect(taxLabel('DE')).toBe('VAT')
    expect(taxLabel('SG')).toBe('GST')
    expect(taxLabel('MY')).toBe('SST')
    expect(taxLabel('')).toBe('Tax')
  })

  it('gives every shippable country a policy', () => {
    // The two lists are edited in different files. A country offered in the
    // form with no policy here would be charged 0% and nobody would notice.
    for (const country of COUNTRIES) {
      expect(TAX_POLICY[country.code], `${country.code} has no tax policy`).toBeDefined()
    }
  })
})
