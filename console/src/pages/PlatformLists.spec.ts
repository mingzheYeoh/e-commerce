import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { enableAutoUnmount, flushPromises, mount, RouterLinkStub } from '@vue/test-utils'
import { reactive } from 'vue'
import Payments from './Payments.vue'
import PlatformOrders from './PlatformOrders.vue'
import Customers from './Customers.vue'
import { customers, merchantNames, payments, platformOrders, type PaymentEntry, type PlatformOrderSummary } from '../api'
import { download } from '../csv'

// The platform's lists: a slow answer to an older filter must never land over
// a newer one, and an export must read one filter from its first page to its last.

const route = reactive({ path: '/platform/payments', query: {} as Record<string, string> })
const replace = vi.fn()
enableAutoUnmount(afterEach)

vi.mock('vue-router', () => ({ useRoute: () => route, useRouter: () => ({ replace }) }))
vi.mock('../api', async (actual) => ({
  ...(await actual<typeof import('../api')>()),
  payments: vi.fn(),
  platformOrders: vi.fn(),
  customers: vi.fn(),
  merchantNames: vi.fn(),
}))
vi.mock('../csv', async (actual) => ({ ...(await actual<typeof import('../csv')>()), download: vi.fn() }))

/** A promise the test answers when it chooses. */
function deferred<T>() {
  let answer!: (v: T) => void
  const promise = new Promise<T>((r) => (answer = r))
  return { promise, answer }
}

const entry = (ref: string): PaymentEntry => ({
  at: '2026-09-25 10:00:00',
  kind: 'payout',
  id: `pay_${ref}`,
  ref,
  merchantIds: ['mch_a'],
  currency: 'USD',
  amount: -100,
  goods: null,
  shipping: null,
  tax: null,
})
const paid = (refs: string[], next: string | null = null) => ({
  status: 200,
  body: { from: '2026-09-01', to: '2026-09-25', next, entries: refs.map(entry), totals: [] },
})

const order = (id: string): PlatformOrderSummary => ({
  id,
  placedAt: '2026-09-25 10:00:00',
  method: 'standard',
  status: 'succeeded',
  items: 1,
  totals: [{ currency: 'USD', minor: 100 }],
  fulfilment: ['pending'],
  merchantIds: ['mch_a'],
})
const listed = (ids: string[], next: string | null = null) => ({ status: 200, body: { from: null, to: null, next, orders: ids.map(order) } })

const mountPage = (page: object) => mount(page, { global: { stubs: { RouterLink: RouterLinkStub } } })
const rows = (w: ReturnType<typeof mount>) => w.findAll('tbody tr').map((r) => r.findAll('td')[2]?.text() ?? r.find('td').text())

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(merchantNames).mockResolvedValue([{ id: 'mch_a', name: 'Acme', status: 'active' }])
})

describe('the payments ledger page', () => {
  beforeEach(() => {
    route.path = '/platform/payments'
    route.query = {}
  })

  it('drops a slow answer to the old filter that lands after the new one', async () => {
    const slow = deferred<Awaited<ReturnType<typeof payments>>>()
    vi.mocked(payments)
      .mockImplementationOnce(() => slow.promise)
      .mockResolvedValueOnce(paid(['NEW']))
    const w = mountPage(Payments)
    route.query = { type: 'payout' }
    await flushPromises()
    slow.answer(paid(['OLD']))
    await flushPromises()
    expect(rows(w)).toEqual(['NEW'])
  })

  it('exports with the filter it started with, even if the filter changes part way', async () => {
    // The first export page is still out when the filter changes; the second is asked for after.
    const first = deferred<Awaited<ReturnType<typeof payments>>>()
    vi.mocked(payments).mockImplementation(async (f) =>
      f.limit !== 200 ? paid([]) : f.before ? paid(['P2']) : first.promise,
    )
    route.query = { merchant: 'mch_a' }
    const w = mountPage(Payments)
    await flushPromises()
    await w.findAll('button').find((b) => b.text().includes('Export CSV'))!.trigger('click')
    route.query = { merchant: 'mch_b' }
    await flushPromises()
    first.answer(paid(['P1'], '2026-09-25 10:00:00|3|pay_P1'))
    await flushPromises()
    const exportCalls = vi.mocked(payments).mock.calls.filter(([f]) => f.limit === 200)
    expect(exportCalls.map(([f]) => [f.merchant, f.before])).toEqual([
      ['mch_a', null],
      ['mch_a', '2026-09-25 10:00:00|3|pay_P1'],
    ])
    const [, csv] = vi.mocked(download).mock.calls[0]
    expect(csv.slice(1).map((r) => r[2])).toEqual(['P1', 'P2'])
  })

  it('says a merchant-filtered charge is that merchant\'s goods alone', async () => {
    vi.mocked(payments).mockResolvedValue(paid([]))
    route.query = { merchant: 'mch_a' }
    const w = mountPage(Payments)
    await flushPromises()
    expect(w.text()).toContain("Filtered to one merchant: charges show only this merchant's goods; shipping and tax belong to the whole order.")
  })
})

describe('the all-orders page', () => {
  beforeEach(() => {
    route.path = '/platform/orders'
    route.query = {}
  })

  it('drops a Load more that answers after the filter changed', async () => {
    const more = deferred<Awaited<ReturnType<typeof platformOrders>>>()
    vi.mocked(platformOrders)
      .mockResolvedValueOnce(listed(['NX-OLD1'], 'c1'))
      .mockImplementationOnce(() => more.promise)
      .mockResolvedValueOnce(listed(['NX-NEW']))
    const w = mountPage(PlatformOrders)
    await flushPromises()
    await w.findAll('button').find((b) => b.text() === 'Load more')!.trigger('click')
    route.query = { merchant: 'mch_a' }
    await flushPromises()
    more.answer(listed(['NX-OLD2']))
    await flushPromises()
    expect(w.findAll('tbody tr').map((r) => r.find('td').text())).toEqual(['NX-NEW'])
  })

  it('exports with the filter it started with', async () => {
    const first = deferred<Awaited<ReturnType<typeof platformOrders>>>()
    vi.mocked(platformOrders).mockImplementation(async (f) =>
      f.limit !== 200 ? listed([]) : f.before ? listed(['NX-B']) : first.promise,
    )
    route.query = { status: 'pending' }
    const w = mountPage(PlatformOrders)
    await flushPromises()
    await w.findAll('button').find((b) => b.text().includes('Export CSV'))!.trigger('click')
    route.query = { status: 'shipped' }
    await flushPromises()
    first.answer(listed(['NX-A'], 'c1'))
    await flushPromises()
    const exportCalls = vi.mocked(platformOrders).mock.calls.filter(([f]) => f.limit === 200)
    expect(exportCalls.map(([f]) => [f.status, f.before])).toEqual([
      ['pending', null],
      ['pending', 'c1'],
    ])
    const [, csv] = vi.mocked(download).mock.calls[0]
    expect(csv.slice(1).map((r) => r[0])).toEqual(['NX-A', 'NX-B'])
  })
})

describe('the customers page', () => {
  beforeEach(() => {
    route.path = '/platform/customers'
    route.query = {}
  })

  it('drops a slow answer to an old search', async () => {
    const slow = deferred<Awaited<ReturnType<typeof customers>>>()
    const page = (name: string) => ({
      status: 200,
      body: {
        next: null,
        guests: null,
        customers: [{ id: name, email: `${name}@x.test`, name, createdAt: '2026-09-01 00:00:00', verified: true, twoFactor: false, orders: 0, lastOrderAt: null, spend: [] }],
      },
    })
    vi.mocked(customers)
      .mockImplementationOnce(() => slow.promise)
      .mockResolvedValueOnce(page('NEW'))
    const w = mountPage(Customers)
    route.query = { q: 'new' }
    await flushPromises()
    slow.answer(page('OLD'))
    await flushPromises()
    expect(w.text()).toContain('NEW')
    expect(w.text()).not.toContain('OLD')
  })
})
