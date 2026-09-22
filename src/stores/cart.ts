import { defineStore } from 'pinia'
import type { Product } from '@/types'
import { products } from '@/data/products'

export interface CartLine {
  /**
   * The catalogue row this line came from, and what the order endpoint prices
   * against. Two merchants may list one sku at two prices, so a sku does not
   * name a product and cannot identify a line.
   */
  productId: string
  /** The merchant's own code for it, for the receipt. Nothing is looked up by it. */
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
 * product alone cannot address them — and a sku does not name a product.
 */
export const lineKey = (line: Pick<CartLine, 'productId' | 'finish'>) =>
  line.finish ? `${line.productId}|${line.finish}` : line.productId

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
      if (!raw) return []

      // `nexus:cart` is written by whichever deploy was last live when a
      // shopper touched their basket, and read by whichever deploy is live
      // now — there is no migration step in between. `as CartLine[]` only
      // asserts the compile-time shape; it proves nothing about the bytes on
      // disk. `productId` was added to `CartLine` after some baskets were
      // already sitting in storage, so a line from before that deploy has no
      // productId at runtime even though the type says it must.
      //
      // Repair it the way `checkout.ts`'s `loadOrder()` repairs a delisted
      // product: look the sku up in the bundled catalogue, which every
      // stored line has always carried. A sku that no longer resolves is
      // dropped, same as this app already treats a delisted product.
      const bySku = new Map(products.map((p) => [p.sku, p]))
      const lines = JSON.parse(raw) as CartLine[]
      return lines.flatMap((line) => {
        if (line.productId) return [line]
        const product = bySku.get(line.sku)
        return product ? [{ ...line, productId: product.id }] : []
      })
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
      const key = lineKey({ productId: product.id, finish: chosen })
      const existing = this.items.find((line) => lineKey(line) === key)

      if (existing) {
        existing.qty = clamp(existing.qty + qty, product.stockCount)
      } else {
        this.items.push({
          productId: product.id,
          sku: product.sku,
          title: product.title,
          brand: product.brand,
          thumb: product.media.thumb,
          unitPriceCents: product.priceMinor,
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
