import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import PaymentSimulator from './PaymentSimulator.vue'

const TITLE = 'NEXUSOHM payment simulator — no real bank is contacted'

const button = (w: ReturnType<typeof mount>, label: string) => w.findAll('button').find((b) => b.text() === label)!

describe('the payment simulator', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('says what it is, and reports each FPX choice', async () => {
    for (const [label, outcome] of [
      ['Approve', 'approved'],
      ['Decline', 'declined'],
      ['Time out', 'timeout'],
    ] as const) {
      const w = mount(PaymentSimulator, { props: { method: 'fpx', channel: 'Maybank2u', amount: '$10.00' } })
      expect(w.get('[role="dialog"]').text()).toContain(TITLE)
      expect(w.text()).toContain('Maybank2u')
      // Names only: nothing here is an image of, or a link to, a bank.
      expect(w.find('img').exists()).toBe(false)
      expect(w.find('a').exists()).toBe(false)
      await button(w, label).trigger('click')
      expect(w.emitted('done')).toEqual([[outcome]])
      w.unmount()
    }
  })

  it('times an e-wallet payment out when its three minutes run down', async () => {
    const w = mount(PaymentSimulator, { props: { method: 'ewallet', channel: 'GrabPay', amount: '$10.00' } })
    expect(w.text()).toContain(TITLE)
    expect(w.text()).toContain('3:00')
    expect(w.find('svg[aria-hidden="true"]').exists()).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(w.text()).toContain('2:00')
    expect(w.emitted('done')).toBeUndefined()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(w.emitted('done')).toEqual([['timeout']])
  })

  it('reports an e-wallet payment made, or cancelled', async () => {
    const paid = mount(PaymentSimulator, { props: { method: 'ewallet', channel: 'Boost', amount: '$1.00' } })
    await button(paid, 'Simulate paid').trigger('click')
    expect(paid.emitted('done')).toEqual([['approved']])
    const gone = mount(PaymentSimulator, { props: { method: 'ewallet', channel: 'Boost', amount: '$1.00' } })
    await button(gone, 'Cancel').trigger('click')
    expect(gone.emitted('done')).toEqual([['cancelled']])
  })
})
