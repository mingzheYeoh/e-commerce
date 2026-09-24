import { describe, it, expect } from 'vitest'
import { COUNTRIES, findCountry, validSubdivision, validPostal, validPhone } from './regions'

/**
 * These rules are enforced twice — once by the checkout form and once by the
 * order endpoint — from this one module. The tests that matter most are the
 * ones about a country having *no* subdivisions, because that is the case an
 * American-shaped address form gets wrong.
 */
describe('countries', () => {
  it('describes every country it offers well enough to render a form', () => {
    for (const c of COUNTRIES) {
      expect(c.code, 'ISO 3166-1 alpha-2').toMatch(/^[A-Z]{2}$/)
      expect(c.name.length).toBeGreaterThan(0)
      expect(c.postalLabel.length).toBeGreaterThan(0)
      // The placeholder has to be an example of what the field accepts, or it
      // is an instruction to type something that will be refused.
      expect(c.postalPattern.test(c.postalExample), `${c.code} example`).toBe(true)
      // A subdivision list and its label travel together; one without the
      // other renders as an unlabelled dropdown or an empty one.
      expect(Boolean(c.subdivisions)).toBe(Boolean(c.subdivisionLabel))
    }
  })

  it('finds a country however the code was typed', () => {
    expect(findCountry('my')?.name).toBe('Malaysia')
    expect(findCountry(' US ')?.name).toBe('United States')
    expect(findCountry('ZZ')).toBeUndefined()
  })
})

describe('validSubdivision', () => {
  it('accepts a subdivision that belongs to the country', () => {
    expect(validSubdivision('US', 'OR')).toBe(true)
    expect(validSubdivision('MY', 'SGR')).toBe(true)
    expect(validSubdivision('us', 'or')).toBe(true)
  })

  it('refuses one that belongs to a different country', () => {
    // The specific confusion this exists to stop: a US state surviving a
    // change of country, leaving an address that validates nowhere and a tax
    // line quoting a state the parcel is not going to.
    expect(validSubdivision('MY', 'OR')).toBe(false)
    expect(validSubdivision('US', 'SGR')).toBe(false)
  })

  it('requires an empty subdivision where the country has none', () => {
    // Not "ignores it". Storing "CA" against a Singapore address would be an
    // address that contradicts itself, and the tax line reads that same field.
    expect(validSubdivision('SG', '')).toBe(true)
    expect(validSubdivision('SG', 'CA')).toBe(false)
    expect(validSubdivision('GB', 'LDN')).toBe(false)
  })

  it('refuses everything for a country the store does not ship to', () => {
    expect(validSubdivision('ZZ', '')).toBe(false)
  })
})

describe('validPostal', () => {
  it('holds each country to its own format', () => {
    expect(validPostal('US', '94016')).toBe(true)
    expect(validPostal('US', '94016-1234')).toBe(true)
    expect(validPostal('CA', 'M5V 2T6')).toBe(true)
    expect(validPostal('GB', 'SW1A 1AA')).toBe(true)
    expect(validPostal('SG', '238839')).toBe(true)
    expect(validPostal('MY', '50450')).toBe(true)
  })

  it('refuses a postcode that is valid somewhere else', () => {
    // The bug in an address form built for one country: a Malaysian postcode
    // refused as a bad ZIP, which reads to the shopper as a broken checkout.
    expect(validPostal('MY', '94016-1234')).toBe(false)
    expect(validPostal('SG', '50450')).toBe(false)
    expect(validPostal('US', 'M5V 2T6')).toBe(false)
  })
})

describe('validPhone', () => {
  it('accepts an empty one, because it is optional', () => {
    expect(validPhone('')).toBe(true)
    expect(validPhone('   ')).toBe(true)
  })

  it('accepts the shapes people actually type', () => {
    expect(validPhone('+60 12-345 6789')).toBe(true)
    expect(validPhone('(555) 010-0199')).toBe(true)
    expect(validPhone('+1 555 010 0199')).toBe(true)
  })

  it('refuses what cannot be a phone number', () => {
    expect(validPhone('12345')).toBe(false)
    expect(validPhone('call me maybe')).toBe(false)
    expect(validPhone('1'.repeat(20))).toBe(false)
  })
})
