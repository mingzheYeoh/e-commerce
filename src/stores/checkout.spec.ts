import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useCheckoutStore } from './checkout'
import { useCartStore } from './cart'
import { products } from '@/data/products'

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
