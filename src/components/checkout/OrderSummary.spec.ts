import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import OrderSummary from './OrderSummary.vue'

/**
 * The summary is the only place the shopper is told *why* a number is what it
 * is, so these are about the small print rather than the arithmetic — which
 * money.spec.ts already covers.
 */
const totals = { subtotal: 239800, shipping: 0, tax: 19184, total: 258984 }

function summary(props: Partial<Record<string, unknown>> = {}) {
  return mount(OrderSummary, {
    props: { lines: [], totals, method: 'standard' as const, ...props },
  })
}

beforeEach(() => setActivePinia(createPinia()))

describe('the tax line', () => {
  it('calls the tax what the destination calls it', () => {
    expect(summary({ country: 'US', state: 'CA' }).text()).toContain('Sales tax')
    expect(summary({ country: 'MY', state: 'SGR' }).text()).toContain('SST')
    expect(summary({ country: 'DE', state: '' }).text()).toContain('VAT')
  })

  it('waits for the state only where the tax actually depends on one', () => {
    /*
     * The bug this file was written for, found by reading the page rather than
     * by a test. Malaysia has states AND a single national rate, so keying the
     * note off "does this country have subdivisions" printed "Added once we
     * have your state" directly above a tax line already reading $191.84.
     */
    const my = summary({ country: 'MY', state: '' }).text()
    expect(my, 'a national rate answers immediately').not.toContain('Added once we have')
    expect(my).toContain('MY · 8%')

    // The US genuinely cannot answer yet, and says so.
    expect(summary({ country: 'US', state: '' }).text()).toContain('Added once we have your state')
    // Canada is the same shape, with its own word for it.
    expect(summary({ country: 'CA', state: '' }).text()).toContain('Added once we have your province')
  })

  it('names the jurisdiction it is quoting', () => {
    // "6.00%" is a number the shopper cannot check. "US-CA · 7.25%" is a claim.
    expect(summary({ country: 'US', state: 'CA' }).text()).toContain('US-CA · 7.25%')
    expect(summary({ country: 'CA', state: 'ON' }).text()).toContain('CA-ON · 13%')
  })

  it('says nothing at all before there is an address', () => {
    expect(summary({ country: '', state: '' }).text()).toContain('Added once we have your address')
  })

  it('reports a genuine zero as none due rather than as missing', () => {
    // Oregon levies no sales tax. That is an answer, not an absence.
    expect(summary({ country: 'US', state: 'OR' }).text()).toContain('US-OR · none due')
  })
})

describe('the shipping line', () => {
  // Delivery that was charged, so the note is the transit time rather than the
  // free-shipping message that replaces it.
  const charged = { ...totals, shipping: 2695 }

  it('quotes the transit time the destination actually gets', () => {
    expect(
      summary({ country: 'US', state: 'OR', method: 'standard', totals: charged }).text(),
    ).toContain('3–5 business days')
    expect(
      summary({ country: 'MY', state: 'SGR', method: 'standard', totals: charged }).text(),
    ).toContain('7–12 business days')
  })

  it('shows the free-delivery promise instead once it has been earned', () => {
    // Which is why the test above has to charge for delivery: this branch wins
    // whenever shipping came to nothing and the method has a threshold.
    expect(summary({ country: 'US', state: 'OR', method: 'standard' }).text()).toContain(
      'Free over',
    )
  })

  it('says so rather than inventing one for a method the address cannot use', () => {
    // Overnight is a US service. The wizard resets the choice, but the summary
    // renders first and must not promise "Next business day" to Kuala Lumpur.
    expect(summary({ country: 'MY', state: 'SGR', method: 'overnight' }).text()).toContain(
      'Not available to this address',
    )
  })

  it('promises duty-paid delivery abroad, and says nothing about it at home', () => {
    const away = summary({ country: 'MY', state: 'SGR' }).text()
    expect(away).toContain('Duties and SST are paid at checkout')
    // Lower-casing the label is what produced "Duties and sst".
    expect(away).not.toContain('sst are paid')

    expect(summary({ country: 'US', state: 'OR' }).text()).not.toContain('Duties')
  })
})
