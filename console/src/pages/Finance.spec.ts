import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { enableAutoUnmount, flushPromises, mount, RouterLinkStub } from '@vue/test-utils'
import { reactive } from 'vue'
import Finance from './Finance.vue'
import { ledger, merchantBalance, payouts } from '../api'

const route = reactive({ path: '/finance', query: {} as Record<string, string> })
const replace = vi.fn(({ query }: { query: Record<string, string> }) => {
  route.query = query
})
enableAutoUnmount(afterEach)
vi.mock('vue-router', () => ({ useRoute: () => route, useRouter: () => ({ replace }) }))
vi.mock('../api', async (actual) => ({
  ...(await actual<typeof import('../api')>()),
  ledger: vi.fn(),
  merchantBalance: vi.fn(async () => ({ status: 200, body: { balances: [] } })),
  payouts: vi.fn(async () => ({ status: 200, body: { payouts: [] } })),
}))

type Statement = Extract<Awaited<ReturnType<typeof ledger>>['body'], { entries: unknown }>
const statement = (from: string, to: string, closing: number): Statement => ({
  from,
  to,
  currentBps: 800,
  summary: [{ currency: 'USD', opening: 0, sales: closing, refunds: 0, commission: 0, payouts: 0, closing }],
  entries: [],
})

describe('the finance page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    route.query = {}
  })

  it('states the month the URL names, and writes a new month back to it', async () => {
    route.query = { month: '2026-02' }
    vi.mocked(ledger).mockResolvedValue({ status: 200, body: statement('2026-02-01', '2026-02-28', 100) })
    const w = mount(Finance, { global: { stubs: { RouterLink: RouterLinkStub } } })
    await flushPromises()
    expect(ledger).toHaveBeenLastCalledWith('2026-02-01', '2026-02-28')
    await w.find('#stmt-month').setValue('2026-03')
    expect(replace).toHaveBeenLastCalledWith({ query: { month: '2026-03' } })
    await flushPromises()
    expect(ledger).toHaveBeenLastCalledWith('2026-03-01', '2026-03-31')
  })

  it("keeps the newest month's statement when an older answer arrives after it", async () => {
    let answerFirst!: (v: Awaited<ReturnType<typeof ledger>>) => void
    route.query = { month: '2026-02' }
    vi.mocked(ledger)
      .mockImplementationOnce(() => new Promise((r) => (answerFirst = r)))
      .mockResolvedValueOnce({ status: 200, body: statement('2026-03-01', '2026-03-31', 333) })
    const w = mount(Finance, { global: { stubs: { RouterLink: RouterLinkStub } } })
    await flushPromises()
    route.query = { month: '2026-03' }
    await flushPromises()
    answerFirst({ status: 200, body: statement('2026-02-01', '2026-02-28', 111) })
    await flushPromises()
    expect(w.text()).toContain('$3.33')
    expect(w.text()).not.toContain('$1.11')
  })

  it('shows an error rather than Loading when a read fails', async () => {
    vi.mocked(merchantBalance).mockResolvedValueOnce({ status: 0, body: { error: "Couldn't reach the server." } })
    vi.mocked(payouts).mockResolvedValueOnce({ status: 200, body: { payouts: [] } })
    vi.mocked(ledger).mockResolvedValue({ status: 0, body: { error: "Couldn't reach the server." } })
    const w = mount(Finance, { global: { stubs: { RouterLink: RouterLinkStub } } })
    await flushPromises()
    expect(w.text()).toContain("Couldn't reach the server.")
    expect(w.text()).not.toContain('Loading…')
  })
})
