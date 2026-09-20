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
