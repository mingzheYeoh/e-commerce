import { beforeEach, describe, it, expect, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import OrderReturns from './OrderReturns.vue'
import { fetchOrderReturns, openReturn, type OrderReturnsView, type ReturnPart } from '@/lib/uploads'

vi.mock('@/lib/uploads', async (actual) => ({
  ...(await actual<typeof import('@/lib/uploads')>()),
  fetchOrderReturns: vi.fn(),
  openReturn: vi.fn(),
}))

const part = (over: Partial<ReturnPart>): ReturnPart => ({
  merchantId: 'mch_a',
  seller: 'Acme Audio',
  status: 'delivered',
  deliveredAt: '2026-09-20 03:06:30',
  returnBy: '2026-10-20 03:06:30',
  canRequest: true,
  requests: [],
  ...over,
})
const view = (parts: ReturnPart[]): OrderReturnsView => ({
  returnDays: 30,
  reasons: ['damaged', 'wrong_item', 'not_as_described', 'changed_mind', 'other'],
  parts,
})

async function render() {
  const w = mount(OrderReturns, { props: { orderId: 'NX-AAAAA' } })
  await flushPromises()
  return w
}

describe('returns on the order page', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('renders nothing for an order that is not this account’s', async () => {
    vi.mocked(fetchOrderReturns).mockResolvedValue({ ok: false, error: 'not signed in' })
    expect((await render()).text()).toBe('')
  })

  it('offers a request only on a part that can take one, and files it', async () => {
    vi.mocked(fetchOrderReturns).mockResolvedValue({
      ok: true,
      data: view([part({}), part({ merchantId: 'mch_b', seller: 'Beta', status: 'shipped', canRequest: false, returnBy: null })]),
    })
    vi.mocked(openReturn).mockResolvedValue({ ok: false, error: 'nope' })
    const w = await render()
    const buttons = w.findAll('button').filter((b) => b.text() === 'Request a return')
    expect(buttons).toHaveLength(1)
    await buttons[0].trigger('click')
    await w.find('select').setValue('wrong_item')
    await w.find('textarea').setValue('Sent the black one')
    await w.find('form').trigger('submit')
    await flushPromises()
    expect(openReturn).toHaveBeenCalledWith('NX-AAAAA', 'mch_a', 'wrong_item', 'Sent the black one')
    expect(w.text()).toContain('nope')
  })

  it('shows each request and its outcome', async () => {
    vi.mocked(fetchOrderReturns).mockResolvedValue({
      ok: true,
      data: view([
        part({
          canRequest: false,
          requests: [
            {
              id: 'ret_1',
              merchantId: 'mch_a',
              reason: 'damaged',
              note: 'Dented',
              status: 'rejected',
              refundMinor: null,
              currency: 'USD',
              decisionNote: 'Outside policy',
              createdAt: '2026-09-21 00:00:00',
              decidedAt: '2026-09-22 00:00:00',
              photos: [],
            },
            {
              id: 'ret_2',
              merchantId: 'mch_a',
              reason: 'other',
              note: '',
              status: 'approved',
              refundMinor: 2500,
              currency: 'USD',
              decisionNote: null,
              createdAt: '2026-09-23 00:00:00',
              decidedAt: '2026-09-24 00:00:00',
              photos: ['/api/account/return-photos/returns/ret_2/ph_a.webp'],
            },
          ],
        }),
      ]),
    })
    const w = await render()
    expect(w.text()).toContain('Arrived damaged')
    expect(w.text()).toContain('Declined')
    expect(w.text()).toContain('Outside policy')
    expect(w.text()).toContain('Refund of $25.00 approved')
    expect(w.find('img').attributes('src')).toMatch(/\/api\/account\/return-photos\/returns\/ret_2\/ph_a\.webp$/)
  })
})
