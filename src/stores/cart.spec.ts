import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useCartStore, lineKey } from './cart'
import { products } from '@/data/products'

const anyProduct = products[0]
// A price that wasn't a round dollar amount (e.g. 899.99) — kept to exercise
// a non-trivial cents value, even though priceMinor is always an integer now.
const fractionalPriced = products.find((p) => p.priceMinor % 100 !== 0)!
const soldOut = products.find((p) => !p.inStock)!
const lowStock = products.find((p) => p.inStock && p.stockCount < 10)!

describe('cart store', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('adds a product as a single line', () => {
    const cart = useCartStore()
    cart.add(anyProduct)
    expect(cart.items).toHaveLength(1)
    expect(cart.count).toBe(1)
  })

  it('merges a repeat add into the existing line', () => {
    const cart = useCartStore()
    cart.add(anyProduct)
    cart.add(anyProduct)
    expect(cart.items).toHaveLength(1)
    expect(cart.items[0].qty).toBe(2)
    expect(cart.count).toBe(2)
  })

  it('clamps quantity to available stock', () => {
    const cart = useCartStore()
    cart.add(lowStock, lowStock.stockCount + 50)
    expect(cart.items[0].qty).toBe(lowStock.stockCount)
  })

  it('refuses to add a sold-out product', () => {
    const cart = useCartStore()
    cart.add(soldOut)
    expect(cart.items).toHaveLength(0)
  })

  it('drops the line when quantity is set to zero', () => {
    const cart = useCartStore()
    cart.add(anyProduct)
    cart.setQty(anyProduct.id, 0)
    expect(cart.items).toHaveLength(0)
  })

  it('totals in integer cents without float drift', () => {
    const cart = useCartStore()
    cart.add(fractionalPriced, 3)

    // 899.95 * 3 would be 2699.8500000000004 in float dollar arithmetic; the
    // cart never does that multiplication in dollars, only in minor units.
    expect(cart.subtotalCents).toBe(fractionalPriced.priceMinor * 3)
    expect(Number.isInteger(cart.subtotalCents)).toBe(true)
  })

  it('sums mixed lines exactly', () => {
    const cart = useCartStore()
    cart.add(fractionalPriced, 2)
    cart.add(anyProduct, 1)
    expect(cart.subtotalCents).toBe(fractionalPriced.priceMinor * 2 + anyProduct.priceMinor)
  })

  it('leaves the drawer closed when an item is added', () => {
    // Quick-add happens mid-browse. Slamming a full-height panel over the grid
    // on every add means dismissing it on every add; the nav counter and the
    // in-place ADDED confirmation carry the feedback instead.
    const cart = useCartStore()
    cart.add(anyProduct)
    expect(cart.isOpen).toBe(false)
  })

  it('removes a line by its key', () => {
    const cart = useCartStore()
    cart.add(anyProduct)
    cart.remove(anyProduct.id)
    expect(cart.items).toHaveLength(0)
    expect(cart.subtotalCents).toBe(0)
  })
})

describe('finishes', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  const multi = () => products.find((p) => p.inStock && p.colorways.length > 1)!

  it('keeps two finishes of one product as two lines', () => {
    // They are different things to ship. Keyed on sku alone the second one
    // silently becomes more of the first.
    const cart = useCartStore()
    const p = multi()
    cart.add(p, 1, p.colorways[0].name)
    cart.add(p, 1, p.colorways[1].name)
    expect(cart.items).toHaveLength(2)
    expect(cart.items.map((l) => l.finish)).toEqual([p.colorways[0].name, p.colorways[1].name])
  })

  it('merges a repeat of the same finish', () => {
    const cart = useCartStore()
    const p = multi()
    cart.add(p, 1, p.colorways[0].name)
    cart.add(p, 2, p.colorways[0].name)
    expect(cart.items).toHaveLength(1)
    expect(cart.items[0].qty).toBe(3)
  })

  it('ignores a finish the product is not sold in', () => {
    // The order endpoint refuses one too. Catching it here means the basket
    // never holds something the checkout will later reject.
    const cart = useCartStore()
    cart.add(multi(), 1, 'Chartreuse')
    expect(cart.items[0].finish).toBeUndefined()
  })

  it('addresses the right line when two finishes share a sku', () => {
    const cart = useCartStore()
    const p = multi()
    cart.add(p, 1, p.colorways[0].name)
    cart.add(p, 5, p.colorways[1].name)

    cart.remove(lineKey({ productId: p.id, finish: p.colorways[0].name }))
    expect(cart.items).toHaveLength(1)
    expect(cart.items[0].finish).toBe(p.colorways[1].name)

    cart.setQty(lineKey(cart.items[0]), 2)
    expect(cart.items[0].qty).toBe(2)
  })
})
