import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { enableAutoUnmount, flushPromises, mount, RouterLinkStub } from '@vue/test-utils'
import { reactive } from 'vue'
import Reports from './Reports.vue'
import { salesReport, type SalesReport } from '../api'

const route = reactive({ path: '/reports', query: {} as Record<string, string> })
const replace = vi.fn(({ query }: { query: Record<string, string> }) => {
  route.query = query
})
// A page left mounted would react to the next test's route change.
enableAutoUnmount(afterEach)

vi.mock('vue-router', () => ({ useRoute: () => route, useRouter: () => ({ replace }) }))
vi.mock('../api', async (actual) => ({ ...(await actual<typeof import('../api')>()), salesReport: vi.fn() }))

const totals = (net: number) => ({ currency: 'USD', gross: net, refunds: 0, net, commission: 0, earnings: net, orders: 1, units: 1 })
const report = (from: string, to: string, products = 0, net = 100): SalesReport => ({
  from,
  to,
  bucket: 'day',
  totals: [totals(net)],
  previous: { from, to, totals: [] },
  series: [],
  categories: [],
  // Best first, as the worker ranks them: p1 highest, pN lowest.
  products: Array.from({ length: products }, (_, i) => ({
    productId: `p${i + 1}`,
    title: `Product ${i + 1}`,
    currency: 'USD',
    gross: 1000 - i,
    net: 1000 - i,
    units: 1,
  })),
})

const mountIt = async () => {
  const w = mount(Reports, { global: { stubs: { RouterLink: RouterLinkStub } } })
  await flushPromises()
  return w
}

describe('the reports page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    route.query = {}
  })

  it('lists as the lowest sellers only products outside the top ten', async () => {
    vi.mocked(salesReport).mockResolvedValue({ status: 200, body: report('2026-09-01', '2026-09-30', 12) })
    const w = await mountIt()
    const bottom = w.findAll('h3').find((h) => h.text().startsWith('Lowest'))!
    expect(bottom.text()).toBe('Lowest 2 of the rest')
    const names = bottom.element.nextElementSibling!.textContent!
    expect(names).toContain('Product 12')
    expect(names).toContain('Product 11')
    expect(names).not.toContain('Product 10')
  })

  it('reads its range from the URL and writes a preset back to it', async () => {
    route.query = { range: 'custom', from: '2026-01-01', to: '2026-01-31' }
    vi.mocked(salesReport).mockResolvedValue({ status: 200, body: report('2026-01-01', '2026-01-31') })
    const w = await mountIt()
    expect(salesReport).toHaveBeenLastCalledWith('2026-01-01', '2026-01-31')
    await w.findAll('button').find((b) => b.text() === '7 days')!.trigger('click')
    expect(replace).toHaveBeenLastCalledWith({ query: { range: '7' } })
  })

  it('keeps the newest answer when an older one arrives after it', async () => {
    let answerFirst!: (v: Awaited<ReturnType<typeof salesReport>>) => void
    vi.mocked(salesReport)
      .mockImplementationOnce(() => new Promise((r) => (answerFirst = r)))
      .mockResolvedValueOnce({ status: 200, body: report('2026-09-24', '2026-09-30', 0, 777) })
    const w = await mountIt()
    // Show a loading state, not a blank page, for the first load.
    expect(w.text()).toContain('Loading…')
    route.query = { range: '7' }
    await flushPromises()
    answerFirst({ status: 200, body: report('2026-09-01', '2026-09-30', 0, 111) })
    await flushPromises()
    expect(w.text()).toContain('$7.77')
    expect(w.text()).not.toContain('$1.11')
  })

  it('shows an error, not an endless Loading, when the server cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    vi.mocked(salesReport).mockImplementation(async (...args) => {
      const real = (await vi.importActual<typeof import('../api')>('../api')).salesReport
      return real(...args)
    })
    const w = await mountIt()
    expect(w.text()).toContain("Couldn't reach the server")
    expect(w.text()).not.toContain('Loading…')
    vi.unstubAllGlobals()
  })
})
