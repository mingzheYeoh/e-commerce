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
  /**
   * The finish the shopper chose, when the product offers more than one.
   *
   * Kept beside the sku rather than folded into it. The flagship section used
   * to build `SEN-HD900-113-CARBON`, which reads fine in a basket and is
   * rejected by the order endpoint as an unknown sku — so the order silently
   * never reached the database, because storing one is deliberately
   * fire-and-forget.
   */
  finish?: string
}

/**
 * What identifies a line. Two finishes of one product are two lines, so the
 * sku alone cannot address them.
 */
export const lineKey = (line: Pick<CartLine, 'sku' | 'finish'>) =>
  line.finish ? `${line.sku}|${line.finish}` : line.sku

const CART_KEY = 'nexus:cart'

/**
 * Storage that cannot throw.
 *
 * Private windows and blocked site data raise on access, and a storefront that
 * cannot remember a basket must still render one.
 */
const stored = {
  read(): CartLine[] {
    try {
      const raw = localStorage.getItem(CART_KEY)
      return raw ? (JSON.parse(raw) as CartLine[]) : []
    } catch {
      return []
    }
  },
  write(items: CartLine[]) {
    try {
      localStorage.setItem(CART_KEY, JSON.stringify(items))
    } catch {
      /* the basket still works for this session */
    }
  },
}

const toCents = (price: number) => Math.round(price * 100)
const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max)

export const useCartStore = defineStore('cart', {
  state: () => ({
    // Restored on load. Without this the cart evaporated on refresh — merely
    // annoying while browsing, and fatal on the third step of checkout.
    items: stored.read(),
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
    add(product: Product, qty = 1, finish?: string) {
      if (!product.inStock || product.stockCount < 1) return

      // Only a finish the product actually offers. Anything else would travel
      // to the order endpoint and be refused there instead.
      const chosen = product.colorways.some((c) => c.name === finish) ? finish : undefined
      const key = lineKey({ sku: product.sku, finish: chosen })
      const existing = this.items.find((line) => lineKey(line) === key)

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
          finish: chosen,
        })
      }
    },

    setQty(key: string, qty: number) {
      const index = this.items.findIndex((line) => lineKey(line) === key)
      if (index === -1) return

      const next = clamp(qty, this.items[index].stockCount)
      if (next === 0) this.items.splice(index, 1)
      else this.items[index].qty = next
    },

    remove(key: string) {
      this.items = this.items.filter((line) => lineKey(line) !== key)
    },

    /** Mirrors the basket to storage. Called after every mutation. */
    persist() {
      stored.write(this.items)
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
