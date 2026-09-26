import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { enableAutoUnmount, flushPromises, mount, RouterLinkStub } from '@vue/test-utils'
import { reactive } from 'vue'
import Orders from './Orders.vue'
import { listOrders, type OrderSummary } from '../api'
import { download } from '../csv'

const route = reactive({ path: '/orders', query: { status: 'pending' } as Record<string, string> })
const replace = vi.fn()
// A page left mounted would react to the next test's route change.
enableAutoUnmount(afterEach)

vi.mock('vue-router', () => ({ useRoute: () => route, useRouter: () => ({ replace }) }))
vi.mock('../api', async (actual) => ({ ...(await actual<typeof import('../api')>()), listOrders: vi.fn() }))
vi.mock('../csv', async (actual) => ({ ...(await actual<typeof import('../csv')>()), download: vi.fn() }))

const order = (id: string, totals: OrderSummary['totals']): OrderSummary => ({
  id,
  placedAt: '2026-09-25 10:00:00',
  method: 'express',
  status: 'succeeded',
  items: 2,
  totals,
  fulfilment: ['pending'],
})

describe('the order history', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reads its filter from the URL and loads the next page after the last', async () => {
    vi.mocked(listOrders)
      .mockResolvedValueOnce({ status: 200, body: { from: null, to: null, next: 'c1', orders: [order('NX-A', [])] } })
      .mockResolvedValueOnce({ status: 200, body: { from: null, to: null, next: null, orders: [order('NX-B', [])] } })
    const w = mount(Orders, { global: { stubs: { RouterLink: RouterLinkStub } } })
    await flushPromises()
    expect(listOrders).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'pending', before: null }))
    await w.findAll('button').find((b) => b.text() === 'Load more')!.trigger('click')
    await flushPromises()
    expect(listOrders).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'pending', before: 'c1' }))
    expect(w.findAll('tbody tr')).toHaveLength(2)
    expect(w.findAll('button').some((b) => b.text() === 'Load more')).toBe(false)
  })

  it('drops a Load more that answers after the filter changed', async () => {
    let answerMore!: (v: Awaited<ReturnType<typeof listOrders>>) => void
    vi.mocked(listOrders)
      .mockResolvedValueOnce({ status: 200, body: { from: null, to: null, next: 'c1', orders: [order('NX-OLD1', [])] } })
      .mockImplementationOnce(() => new Promise((r) => (answerMore = r)))
      .mockResolvedValueOnce({ status: 200, body: { from: null, to: null, next: null, orders: [order('NX-NEW', [])] } })
    const w = mount(Orders, { global: { stubs: { RouterLink: RouterLinkStub } } })
    await flushPromises()
    await w.findAll('button').find((b) => b.text() === 'Load more')!.trigger('click')
    route.query = { status: 'shipped' }
    await flushPromises()
    answerMore({ status: 200, body: { from: null, to: null, next: null, orders: [order('NX-OLD2', [])] } })
    await flushPromises()
    const ids = w.findAll('tbody tr').map((r) => r.find('td').text())
    expect(ids).toEqual(['NX-NEW'])
    route.query = { status: 'pending' }
  })

  it('exports every page of the filtered list, one row per currency, with nothing personal', async () => {
    vi.mocked(listOrders)
      .mockResolvedValueOnce({ status: 200, body: { from: null, to: null, next: null, orders: [] } })
      .mockResolvedValueOnce({
        status: 200,
        body: { from: null, to: null, next: 'c1', orders: [order('NX-A', [{ currency: 'SGD', minor: 700 }, { currency: 'USD', minor: 250005 }])] },
      })
      .mockResolvedValueOnce({ status: 200, body: { from: null, to: null, next: null, orders: [order('NX-B', [{ currency: 'USD', minor: -1 }])] } })
    const w = mount(Orders, { global: { stubs: { RouterLink: RouterLinkStub } } })
    await flushPromises()
    await w.findAll('button').find((b) => b.text().includes('Export CSV'))!.trigger('click')
    await flushPromises()

    expect(vi.mocked(listOrders).mock.calls.slice(1).map(([f]) => [f.status, f.before, f.limit])).toEqual([
      ['pending', null, 200],
      ['pending', 'c1', 200],
    ])
    const [, rows] = vi.mocked(download).mock.calls[0]
    expect(rows).toEqual([
      ['Order', 'Placed (UTC)', 'Status', 'Items', 'Shipping', 'Currency', 'Your total'],
      ['NX-A', '2026-09-25 10:00', 'To ship', 2, 'Express', 'SGD', '7.00'],
      ['NX-A', '2026-09-25 10:00', 'To ship', 2, 'Express', 'USD', '2500.05'],
      ['NX-B', '2026-09-25 10:00', 'To ship', 2, 'Express', 'USD', '-0.01'],
    ])
  })
})
