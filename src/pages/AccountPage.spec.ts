import { beforeEach, describe, it, expect, vi } from 'vitest'
import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import AccountPage from './AccountPage.vue'
import { useAuthStore } from '@/stores/auth'
import { fetchOrder, myOrders, type RemoteOrder } from '@/lib/api'

vi.mock('@/lib/api', async (actual) => ({
  ...(await actual<typeof import('@/lib/api')>()),
  fetchOrder: vi.fn(),
  myOrders: vi.fn(),
}))

const remote: RemoteOrder = {
  id: 'NX-4K2P9',
  placedAt: '2026-09-20 03:06:30',
  email: 'a•••@example.com',
  address: { name: 'Ada Lovelace', phone: '', country: 'US', line1: '1 Road', line2: '', city: 'Portland', state: 'OR', postal: '97201' },
  method: 'standard',
  currency: 'USD',
  totals: { subtotal: 5000, shipping: 895, tax: 0, total: 5895 },
  paymentCode: 'succeeded',
  lines: [{ productId: 'prd_gone', sku: 'S1', title: 'Old Phone', qty: 2, unitPriceCents: 2500, seller: 'Acme Audio', status: 'shipped' }],
}

async function render() {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)*', component: { template: '<div />' } }] })
  await router.push('/account')
  const auth = useAuthStore()
  auth.status = 'in'
  auth.user = { id: 'usr_1', email: 'ada@example.com', name: 'Ada Lovelace' }
  const w = mount(AccountPage, {
    global: { plugins: [router], stubs: { AccountSettings: true, RouterLink: RouterLinkStub } },
  })
  await flushPromises()
  return w
}

describe('the account page orders', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(fetchOrder).mockReset()
    vi.mocked(fetchOrder).mockResolvedValue(remote)
    vi.mocked(myOrders).mockResolvedValue([
      { id: 'NX-4K2P9', placedAt: '2026-09-20 03:06:30', total: 5895, currency: 'USD', paymentCode: 'succeeded', itemCount: 2, fulfilment: [], refunded: [] },
    ])
  })

  it('opens a row to its lines, fetched once, the first time it is opened', async () => {
    const w = await render()
    const toggle = w.find('button[aria-expanded]')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(fetchOrder).not.toHaveBeenCalled()

    await toggle.trigger('click')
    await flushPromises()
    expect(toggle.attributes('aria-expanded')).toBe('true')
    expect(fetchOrder).toHaveBeenCalledWith('NX-4K2P9')
    const text = w.text()
    expect(text).toContain('Old Phone')
    expect(text).toContain('no longer available')
    expect(text).toContain('Sold by Acme Audio')
    expect(text).toContain('$8.95')

    await toggle.trigger('click')
    await toggle.trigger('click')
    await flushPromises()
    expect(fetchOrder).toHaveBeenCalledTimes(1)
  })
})
