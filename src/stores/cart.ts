import { defineStore } from 'pinia'
import type { Product } from '@/types'

export interface CartLine {
  sku: string
  title: string
  brand: string
  thumb: string
  /** Frozen at add time so a later price change never rewrites a bag. */
  unitPriceCents: number
  qty: number
  stockCount: number
}

const toCents = (price: number) => Math.round(price * 100)
const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max)

export const useCartStore = defineStore('cart', {
  state: () => ({
    items: [] as CartLine[],
    isOpen: false,
  }),

  getters: {
    count: (state) => state.items.reduce((total, line) => total + line.qty, 0),

    /**
     * Cents, not dollars. Every total in the UI derives from this, so float
     * cents can never accumulate across lines.
     */
    subtotalCents: (state) =>
      state.items.reduce((total, line) => total + line.unitPriceCents * line.qty, 0),
  },

  actions: {
    add(product: Product, qty = 1) {
      if (!product.inStock || product.stockCount < 1) return

      const existing = this.items.find((line) => line.sku === product.sku)
      if (existing) {
        existing.qty = clamp(existing.qty + qty, product.stockCount)
      } else {
        this.items.push({
          sku: product.sku,
          title: product.title,
          brand: product.brand,
          thumb: product.media.thumb,
          unitPriceCents: toCents(product.price),
          qty: clamp(qty, product.stockCount),
          stockCount: product.stockCount,
        })
      }
      this.isOpen = true
    },

    setQty(sku: string, qty: number) {
      const index = this.items.findIndex((line) => line.sku === sku)
      if (index === -1) return

      const next = clamp(qty, this.items[index].stockCount)
      if (next === 0) this.items.splice(index, 1)
      else this.items[index].qty = next
    },

    remove(sku: string) {
      this.items = this.items.filter((line) => line.sku !== sku)
    },

    open() {
      this.isOpen = true
    },
    close() {
      this.isOpen = false
    },
    toggle() {
      this.isOpen = !this.isOpen
    },
  },
})
