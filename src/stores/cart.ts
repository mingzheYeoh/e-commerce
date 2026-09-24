import { defineStore } from 'pinia'
import type { Product } from '@/types'
import { catalogue, catalogueStatus, findProduct } from './catalog'

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
  /**
   * The price when it was added. Kept for storage only: what the bag shows and
   * charges is the live catalogue price, via the `lines` getter, because the
   * order endpoint re-prices from the live catalogue anyway - a frozen price
   * here would only be a second price for one product.
   */
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
 * A stored line joined to the live catalogue.
 *
 * `available` is false once the product is no longer published (unpublished,
 * archived, merchant suspended) or is sold out. The line stays in the bag so
 * the shopper can see what happened, but checkout refuses it. The order
 * endpoint refuses an unpublished product too; it does NOT check stock, so a
 * sold-out line is stopped here or nowhere.
 *
 * `qty` is the stored quantity clamped to live stock, and `limited` says the
 * clamp bit. Bag, subtotal and the posted order all use this `qty`, so they
 * cannot disagree about how many are being bought.
 */
export interface CartView extends CartLine {
  available: boolean
  limited: boolean
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
      // product: look the sku up in the catalogue, which every
      // stored line has always carried. A sku that no longer resolves is
      // dropped, same as this app already treats a delisted product.
      const bySku = new Map(catalogue.value.map((p) => [p.sku, p]))
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
    /** Units in the bag, as the bag shows them (clamped to live stock). */
    count(): number {
      return this.lines.reduce((total, line) => total + line.qty, 0)
    },

    /**
     * What the bag renders and what checkout orders: each line with the live
     * price, stock, title and image of its product.
     *
     * A product missing from the list is gone only once the live catalogue
     * has answered. Before that - or when the fetch failed - it may just be
     * newer than the build-time snapshot, so its stored line stands in and the
     * server, which re-prices every line, has the final word.
     */
    lines: (state): CartView[] =>
      state.items.map((line) => {
        const p = findProduct(line.productId)
        if (!p) return { ...line, available: catalogueStatus.value !== 'live', limited: false }
        // A sold-out line keeps its quantity: it is unavailable, not zero.
        const qty = p.stockCount > 0 ? Math.min(line.qty, p.stockCount) : line.qty
        return {
          ...line,
          title: p.title,
          brand: p.brand,
          thumb: p.media.thumb,
          unitPriceCents: p.priceMinor,
          stockCount: p.stockCount,
          qty,
          limited: qty < line.qty,
          available: p.inStock && p.stockCount > 0,
        }
      }),

    /** Any line that cannot be ordered. Checkout refuses while this is true. */
    hasUnavailable(): boolean {
      return this.lines.some((line) => !line.available)
    },

    /**
     * Cents, not dollars. Every total in the UI derives from this, so float
     * cents can never accumulate across lines. Unavailable lines are not in it:
     * they cannot be bought, so they cannot be owed.
     */
    subtotalCents(): number {
      return this.lines.reduce(
        (total, line) => (line.available ? total + line.unitPriceCents * line.qty : total),
        0,
      )
    },
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

      const line = this.items[index]
      const next = clamp(qty, findProduct(line.productId)?.stockCount ?? line.stockCount)
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
