import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils'
import OrderDetail from './OrderDetail.vue'
import { getOrder, shipOrder, cancelOrder, refundLine, type OrderDetail as Detail } from '../api'

vi.mock('../api', async (actual) => ({
  ...(await actual<typeof import('../api')>()),
  getOrder: vi.fn(),
  shipOrder: vi.fn(async () => ({ status: 200, body: {} })),
  deliverOrder: vi.fn(async () => ({ status: 200, body: {} })),
  cancelOrder: vi.fn(async () => ({ status: 200, body: {} })),
  refundLine: vi.fn(async () => ({ status: 201, body: {} })),
}))

const detail = (status: Detail['fulfilment'][number]['status']): Detail => ({
  id: 'NX-4K2P9',
  placedAt: '2026-09-25 10:00:00',
  method: 'standard',
  status: 'succeeded',
  shipTo: { name: 'Ada', line1: '1 Road', line2: '', city: 'Town', state: 'OR', postal: '97201', country: 'US' },
  lines: [
    { productId: 'p1', merchantId: 'm', sku: 'S1', title: 'Phone', finish: null, qty: 2, unitMinor: 1000, currency: 'USD', refundedQty: 0, refundedMinor: 0 },
  ],
  totals: [{ currency: 'USD', minor: 2000 }],
  fulfilment: [{ merchantId: 'm', status, carrier: null, tracking: null, shippedAt: null, deliveredAt: null, updatedAt: '' }],
})

const render = async (status: Detail['fulfilment'][number]['status']) => {
  vi.mocked(getOrder).mockResolvedValue({ status: 200, body: detail(status) })
  const w = mount(OrderDetail, { props: { id: 'NX-4K2P9' }, global: { stubs: { RouterLink: RouterLinkStub } } })
  await flushPromises()
  return w
}

const buttons = (w: Awaited<ReturnType<typeof render>>) => w.findAll('button').map((b) => b.text())

describe('the order page actions', () => {
  beforeEach(() => vi.clearAllMocks())

  it('offers shipping and cancelling only while pending, and delivery only once shipped', async () => {
    expect(buttons(await render('pending'))).toEqual(expect.arrayContaining(['Mark shipped', 'Cancel']))
    expect(buttons(await render('shipped'))).toContain('Mark delivered')
    expect(buttons(await render('shipped'))).not.toContain('Cancel')
    expect(buttons(await render('delivered'))).not.toContain('Mark delivered')
  })

  it('ships with the carrier and tracking number typed in', async () => {
    const w = await render('pending')
    await w.findAll('button').find((b) => b.text() === 'Mark shipped')!.trigger('click')
    await w.find('#ship-carrier').setValue('UPS')
    await w.find('#ship-tracking').setValue(' 1Z999 ')
    await w.find('form').trigger('submit')
    await flushPromises()
    expect(shipOrder).toHaveBeenCalledWith('NX-4K2P9', 'UPS', '1Z999')
  })

  it('cancels only after the merchant confirms', async () => {
    const w = await render('pending')
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    const cancel = w.findAll('button').find((b) => b.text() === 'Cancel')!
    await cancel.trigger('click')
    expect(cancelOrder).not.toHaveBeenCalled()
    await cancel.trigger('click')
    await flushPromises()
    expect(cancelOrder).toHaveBeenCalledWith('NX-4K2P9')
    confirm.mockRestore()
  })

  it('refunds a line in minor units, after confirming the amount', async () => {
    const w = await render('shipped')
    await w.findAll('button').find((b) => b.text() === 'Refund')!.trigger('click')
    await w.find('input[id^="amount-"]').setValue('12.50')
    await w.find('input[id^="reason-"]').setValue('Scratched')
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await w.findAll('form').at(-1)!.trigger('submit')
    await flushPromises()
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('12.50'))
    expect(refundLine).toHaveBeenCalledWith('NX-4K2P9', { productId: 'p1', finish: null, qty: 1, amountMinor: 1250, reason: 'Scratched' })
    confirm.mockRestore()
  })

  it("shows the worker's refusal rather than swallowing it", async () => {
    vi.mocked(refundLine).mockResolvedValueOnce({ status: 409, body: { error: 'Only 5.00 USD is left to refund on this line.' } })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const w = await render('pending')
    await w.findAll('button').find((b) => b.text() === 'Refund')!.trigger('click')
    await w.find('input[id^="reason-"]').setValue('x')
    await w.findAll('form').at(-1)!.trigger('submit')
    await flushPromises()
    expect(w.find('[role="alert"]').text()).toBe('Only 5.00 USD is left to refund on this line.')
  })
})
