import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useCartStore } from './cart'
import { products } from '@/data/products'

const anyProduct = products[0]
const fractionalPriced = products.find((p) => !Number.isInteger(p.price))!
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
    cart.setQty(anyProduct.sku, 0)
    expect(cart.items).toHaveLength(0)
  })

  it('totals in integer cents without float drift', () => {
    const cart = useCartStore()
    cart.add(fractionalPriced, 3)

    // 899.95 * 3 is 2699.8500000000004 in float arithmetic.
    expect(cart.subtotalCents).toBe(Math.round(fractionalPriced.price * 100) * 3)
    expect(Number.isInteger(cart.subtotalCents)).toBe(true)
  })

  it('sums mixed lines exactly', () => {
    const cart = useCartStore()
    cart.add(fractionalPriced, 2)
    cart.add(anyProduct, 1)
    expect(cart.subtotalCents).toBe(
      Math.round(fractionalPriced.price * 100) * 2 + Math.round(anyProduct.price * 100),
    )
  })

  it('opens the drawer when an item is added', () => {
    const cart = useCartStore()
    expect(cart.isOpen).toBe(false)
    cart.add(anyProduct)
    expect(cart.isOpen).toBe(true)
  })

  it('removes a line by sku', () => {
    const cart = useCartStore()
    cart.add(anyProduct)
    cart.remove(anyProduct.sku)
    expect(cart.items).toHaveLength(0)
    expect(cart.subtotalCents).toBe(0)
  })
})
