import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils'
import { reactive } from 'vue'
import Inventory from './Inventory.vue'
import { inventory, updateProduct, UNREACHABLE, type InventoryItem } from '../api'

// A route whose query the page's own router.replace really changes, as vue-router's does.
const route = reactive({ query: {} as Record<string, string> })
const replace = vi.fn(({ query }: { query: Record<string, string> }) => {
  route.query = query
})
vi.mock('vue-router', () => ({ useRoute: () => route, useRouter: () => ({ replace }) }))
vi.mock('../api', async (actual) => ({
  ...(await actual<typeof import('../api')>()),
  inventory: vi.fn(),
  updateProduct: vi.fn(),
}))

const item = (id: string, stockCount: number, sold30d: number, status: InventoryItem['status'] = 'published'): InventoryItem => ({
  id,
  sku: `SKU-${id}`,
  title: `Title ${id}`,
  category: 'phones',
  status,
  priceMinor: 1000,
  currency: 'USD',
  stockCount,
  sold30d,
})

async function render() {
  vi.mocked(inventory).mockResolvedValue({
    status: 200,
    body: { lowStockAt: 5, products: [item('a', 3, 6), item('b', 0, 0), item('c', 40, 0, 'draft')] },
  })
  const w = mount(Inventory, { global: { stubs: { RouterLink: RouterLinkStub } } })
  await flushPromises()
  return w
}

const rows = (w: Awaited<ReturnType<typeof render>>) => w.findAll('tbody tr').map((r) => r.findAll('td').map((c) => c.text()))

describe('the inventory page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    route.query = {}
  })

  it('shows days of cover as stock over daily sales, and a dash with no sales', async () => {
    const w = await render()
    // a: 3 in stock, 6 sold in 30 days = 0.2 a day, so 15 days.
    expect(rows(w).map((r) => [r[4], r[5]])).toEqual([
      ['6', '15'],
      ['0', '—'],
      ['0', '—'],
    ])
  })

  it('filters to low and to out of stock, counting live products only, and keeps the filter in the URL', async () => {
    const w = await render()
    await w.findAll('button').find((b) => b.text().startsWith('Low stock'))!.trigger('click')
    expect(replace).toHaveBeenLastCalledWith({ query: { filter: 'low' } })
    expect(w.findAll('tbody tr')).toHaveLength(1)
    await w.findAll('button').find((b) => b.text() === 'Out of stock')!.trigger('click')
    expect(rows(w)[0][1]).toContain('Title b')
  })

  it('opens on the filter the URL names', async () => {
    route.query = { filter: 'out' }
    const w = await render()
    expect(rows(w).map((r) => r[1])).toEqual([expect.stringContaining('Title b')])
  })

  it('carries on past a row the server never answered, and says how many were refused', async () => {
    vi.mocked(updateProduct).mockImplementation(async (id, patch) => {
      if (id === 'a') throw new TypeError('Failed to fetch')
      return { status: 200, body: { ...item(id, 0, 0), stockCount: patch.stockCount! } as never }
    })
    const w = await render()
    const boxes = w.findAll('tbody input[type="checkbox"]')
    await boxes[0].setValue(true)
    await boxes[1].setValue(true)
    await w.find('#bulk-stock').setValue('7')
    await w.find('form[aria-label="Set stock for the selected products"]').trigger('submit')
    await flushPromises()
    expect(updateProduct).toHaveBeenCalledTimes(2)
    expect(w.text()).toContain('1 updated, 1 refused')
    expect(w.text()).toContain(UNREACHABLE)
    // Not stuck: the form can be used again.
    expect(w.find('form[aria-label="Set stock for the selected products"] button[type="submit"]').attributes('disabled')).toBeUndefined()
  })

  it('never sets stock on a row the filter hides: changing the filter drops the selection', async () => {
    vi.mocked(updateProduct).mockResolvedValue({ status: 200, body: { ...item('b', 0, 0), stockCount: 9 } as never })
    const w = await render()
    const boxes = w.findAll('tbody input[type="checkbox"]')
    await boxes[0].setValue(true) // a, low stock
    await w.findAll('button').find((b) => b.text() === 'Out of stock')!.trigger('click')
    expect(w.find('form[aria-label="Set stock for the selected products"]').exists()).toBe(false)
    await w.find('tbody input[type="checkbox"]').setValue(true) // b, the only row shown
    await w.find('#bulk-stock').setValue('9')
    await w.find('form[aria-label="Set stock for the selected products"]').trigger('submit')
    await flushPromises()
    expect(vi.mocked(updateProduct).mock.calls).toEqual([['b', { stockCount: 9 }]])
  })

  it('sets stock for every selected row through the product update, and keeps a refusal on its row', async () => {
    vi.mocked(updateProduct).mockImplementation(async (id, patch) =>
      id === 'b'
        ? { status: 409, body: { error: 'Before publishing, add at least one photo.' } }
        : { status: 200, body: { ...item(id, 0, 0), stockCount: patch.stockCount! } as never },
    )
    const w = await render()
    const boxes = w.findAll('tbody input[type="checkbox"]')
    await boxes[0].setValue(true)
    await boxes[1].setValue(true)
    await w.find('#bulk-stock').setValue('12')
    await w.find('form[aria-label="Set stock for the selected products"]').trigger('submit')
    await flushPromises()

    expect(vi.mocked(updateProduct).mock.calls).toEqual([
      ['a', { stockCount: 12 }],
      ['b', { stockCount: 12 }],
    ])
    expect(w.text()).toContain('1 updated, 1 refused')
    expect(w.text()).toContain('Before publishing, add at least one photo.')
    expect((w.find('input[aria-label="Stock for Title a"]').element as HTMLInputElement).value).toBe('12')
  })

  it('refuses a stock that is not a whole number without sending anything', async () => {
    const w = await render()
    const input = w.find('input[aria-label="Stock for Title a"]')
    await input.setValue('2.5')
    ;(input.element as HTMLInputElement).form!.dispatchEvent(new Event('submit'))
    await flushPromises()
    expect(updateProduct).not.toHaveBeenCalled()
    expect(w.text()).toContain('Stock is a whole number')
  })
})
