import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useCheckoutStore } from './checkout'
import { useCartStore } from './cart'
import { products } from '@/data/products'
import { saveOrder, fetchOrder, type RemoteOrder } from '@/lib/api'

/**
 * The API is stubbed rather than reached. These tests are about what the store
 * does with an answer, and a suite that needs the network to pass is a suite
 * that fails on a train.
 */
vi.mock('@/lib/api', () => ({
  saveOrder: vi.fn(async () => true),
  fetchOrder: vi.fn(async () => null),
}))
const mockSave = vi.mocked(saveOrder)
const mockFetch = vi.mocked(fetchOrder)

const inStock = () => products.find((p) => p.inStock)!

function fill(store: ReturnType<typeof useCheckoutStore>) {
  store.address.name = 'Ada Lovelace'
  store.address.email = 'ada@example.com'
  store.address.line1 = '12 Dean Street'
  store.address.city = 'London'
  store.address.state = 'CA'
  store.address.postal = '94016'
  store.method = 'standard'
}

describe('checkout store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    mockSave.mockClear()
    mockSave.mockResolvedValue(true)
    mockFetch.mockReset()
    mockFetch.mockResolvedValue(null)
  })

  it('will not advance past an incomplete address', () => {
    const checkout = useCheckoutStore()
    expect(checkout.stepValid(1)).toBe(false)
    fill(checkout)
    expect(checkout.stepValid(1)).toBe(true)
  })

  it('rejects an address that is only nearly complete', () => {
    const checkout = useCheckoutStore()
    fill(checkout)
    checkout.address.postal = '941'
    expect(checkout.stepValid(1)).toBe(false)
    checkout.address.postal = '94016'
    checkout.address.email = 'not-an-email'
    expect(checkout.stepValid(1)).toBe(false)
  })

  it('leaves the cart untouched when the card is declined', async () => {
    // The constraint most likely to be written backwards. One declined card must
    // not empty someone's basket.
    const cart = useCartStore()
    const checkout = useCheckoutStore()
    cart.add(inStock())
    fill(checkout)
    checkout.card.number = '4000 0000 0000 0002'

    const result = await checkout.place()

    expect(result.ok).toBe(false)
    expect(cart.count).toBe(1)
    expect(checkout.error).toContain('declined')
  })

  it('empties the cart only after the charge succeeds', async () => {
    const cart = useCartStore()
    const checkout = useCheckoutStore()
    cart.add(inStock())
    fill(checkout)
    checkout.card.number = '4242 4242 4242 4242'

    const result = await checkout.place()

    expect(result.ok).toBe(true)
    expect(cart.count).toBe(0)
  })

  it('refuses to place an order for an empty cart', async () => {
    const checkout = useCheckoutStore()
    fill(checkout)
    checkout.card.number = '4242 4242 4242 4242'

    const result = await checkout.place()
    expect(result.ok).toBe(false)
  })

  it('records the order so the confirmation page survives a reload', async () => {
    const cart = useCartStore()
    const checkout = useCheckoutStore()
    cart.add(inStock())
    fill(checkout)
    checkout.card.number = '4242 4242 4242 4242'

    const result = await checkout.place()
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // /order/:id is a URL people reload and bookmark; the order has to outlive
    // the tab that placed it.
    const stored = JSON.parse(localStorage.getItem('nexus:orders') ?? '[]')
    expect(stored.find((o: { id: string }) => o.id === result.id)).toBeTruthy()
  })

  it('freezes the totals onto the order rather than recomputing them later', async () => {
    const cart = useCartStore()
    const checkout = useCheckoutStore()
    const product = inStock()
    cart.add(product)
    fill(checkout)
    checkout.method = 'overnight'
    checkout.card.number = '4242 4242 4242 4242'

    const expected = checkout.totals.total
    const result = await checkout.place()
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const order = checkout.findOrder(result.id)
    expect(order?.totals.total).toBe(expected)
    expect(order?.lines[0].unitPriceCents).toBe(Math.round(product.price * 100))
  })

  it('carries a declined attempt in the error rather than silently failing', async () => {
    const cart = useCartStore()
    const checkout = useCheckoutStore()
    cart.add(inStock())
    fill(checkout)
    checkout.card.number = '4000 0000 0000 9995'

    await checkout.place()
    expect(checkout.error).toMatch(/insufficient/i)
  })

  it('survives localStorage being unavailable', () => {
    // Private windows and blocked site data throw on access. A storefront has
    // to render anyway.
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const cart = useCartStore()
    expect(() => cart.add(inStock())).not.toThrow()
    spy.mockRestore()
  })
})

describe('orders beyond this browser', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    mockSave.mockClear()
    mockSave.mockResolvedValue(true)
    mockFetch.mockReset()
    mockFetch.mockResolvedValue(null)
  })

  it('sends skus and quantities, never prices', async () => {
    // The server prices the order from its own catalogue. Anything this
    // payload said about money would be a number the client chose.
    const cart = useCartStore()
    const checkout = useCheckoutStore()
    cart.add(inStock(), 2)
    fill(checkout)
    checkout.card.number = '4242 4242 4242 4242'

    const res = await checkout.place()
    expect(res.ok).toBe(true)

    const sent = mockSave.mock.calls[0][0]
    expect(sent.lines).toEqual([{ sku: inStock().sku, qty: 2 }])
    expect(JSON.stringify(sent)).not.toMatch(/unitPrice|total|subtotal/i)
  })

  it('completes the purchase even when the order cannot be stored', async () => {
    // A database outage costs the shareable copy of an order. It must not cost
    // the order, and it must not show the shopper an error for a card that was
    // accepted.
    mockSave.mockResolvedValue(false)
    const cart = useCartStore()
    const checkout = useCheckoutStore()
    cart.add(inStock())
    fill(checkout)
    checkout.card.number = '4242 4242 4242 4242'

    const res = await checkout.place()
    expect(res.ok).toBe(true)
    expect(checkout.error).toBe('')
    expect(cart.items).toHaveLength(0)
  })

  it('reads an order this browser never placed', async () => {
    const product = inStock()
    const remote: RemoteOrder = {
      id: 'NX-7H3QK',
      placedAt: '2026-09-20 03:06:30',
      email: 'a•••@example.com',
      address: {
        name: 'Ada Lovelace',
        line1: '12 Analytical Way',
        city: 'Portland',
        state: 'OR',
        postal: '97201',
      },
      method: 'standard',
      currency: 'USD',
      totals: { subtotal: 239800, shipping: 0, tax: 0, total: 239800 },
      paymentCode: 'succeeded',
      lines: [{ sku: product.sku, title: product.title, qty: 2, unitPriceCents: 119900 }],
    }
    mockFetch.mockResolvedValue(remote)

    const checkout = useCheckoutStore()
    const order = await checkout.loadOrder('NX-7H3QK')

    expect(order).not.toBeNull()
    expect(order!.totals.total).toBe(239800)
    // Imagery is catalogue data, refilled on read rather than stored per order.
    expect(order!.lines[0].thumb).toBe(product.media.thumb)
    expect(order!.address.email).toBe('a•••@example.com')
    // It came from the server, so the receipt may say so.
    expect(checkout.synced['NX-7H3QK']).toBe(true)
  })

  it('prefers the local record and does not call the API for it', async () => {
    const cart = useCartStore()
    const checkout = useCheckoutStore()
    cart.add(inStock())
    fill(checkout)
    checkout.card.number = '4242 4242 4242 4242'
    const placed = await checkout.place()
    expect(placed.ok).toBe(true)

    const order = await checkout.loadOrder((placed as { id: string }).id)
    expect(order).not.toBeNull()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('renders a delisted product without a thumbnail rather than failing', async () => {
    mockFetch.mockResolvedValue({
      id: 'NX-4K2P9',
      placedAt: '2026-09-20 03:06:30',
      email: 'a•••@example.com',
      address: { name: 'Ada', line1: '1 St', city: 'LA', state: 'CA', postal: '90001' },
      method: 'express',
      currency: 'USD',
      totals: { subtotal: 5000, shipping: 1495, tax: 363, total: 6858 },
      paymentCode: 'succeeded',
      lines: [{ sku: 'GONE-FOREVER-1', title: 'Discontinued Thing', qty: 1, unitPriceCents: 5000 }],
    } as RemoteOrder)

    const order = await useCheckoutStore().loadOrder('NX-4K2P9')
    expect(order!.lines[0].title).toBe('Discontinued Thing')
    expect(order!.lines[0].thumb).toBe('')
  })

  it('returns null when the order does not exist anywhere', async () => {
    expect(await useCheckoutStore().loadOrder('NX-QQQQQ')).toBeNull()
  })
})
