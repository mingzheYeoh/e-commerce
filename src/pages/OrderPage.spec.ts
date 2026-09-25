import { beforeEach, describe, it, expect, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import OrderPage from './OrderPage.vue'
import { fetchOrder, type RemoteOrder } from '@/lib/api'

vi.mock('@/lib/api', async (actual) => ({ ...(await actual<typeof import('@/lib/api')>()), fetchOrder: vi.fn() }))

const remote: RemoteOrder = {
  id: 'NX-4K2P9',
  placedAt: '2026-09-20 03:06:30',
  email: 'a•••@example.com',
  address: { name: 'Ada Lovelace', phone: '', country: 'US', line1: '1 Road', line2: '', city: 'Portland', state: 'OR', postal: '97201' },
  method: 'standard',
  currency: 'USD',
  totals: { subtotal: 5000, shipping: 0, tax: 0, total: 5000 },
  paymentCode: 'succeeded',
  lines: [{ sku: 'S1', title: 'Phone', qty: 2, unitPriceCents: 2500 }],
}

async function render() {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)*', component: { template: '<div />' } }] })
  await router.push('/order/NX-4K2P9')
  const w = mount(OrderPage, { props: { id: 'NX-4K2P9' }, global: { plugins: [router] } })
  await flushPromises()
  return w
}

describe('the order page', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it("shows the account that placed the order each seller's status, tracking and refunds", async () => {
    vi.mocked(fetchOrder).mockResolvedValue({
      ...remote,
      parts: [
        {
          seller: 'Acme Audio',
          status: 'shipped',
          carrier: 'UPS',
          tracking: '1Z999AA1',
          shippedAt: '2026-09-21 10:00:00',
          deliveredAt: null,
          items: [{ sku: 'S1', title: 'Phone', qty: 2 }],
          refunded: [{ currency: 'USD', minor: 2500 }],
        },
      ],
    })
    const text = (await render()).text()
    expect(text).toContain('Shipments')
    expect(text).toContain('Acme Audio')
    expect(text).toContain('Shipped')
    expect(text).toContain('UPS · tracking 1Z999AA1')
    expect(text).toContain('Refunded $25.00')
  })

  it('shows anyone else the order without its shipments, as before', async () => {
    vi.mocked(fetchOrder).mockResolvedValue(remote)
    const text = (await render()).text()
    expect(text).toContain('Order confirmed')
    expect(text).not.toContain('Shipments')
    expect(text).not.toContain('tracking')
    expect(text).not.toContain('Refunded')
  })
})
