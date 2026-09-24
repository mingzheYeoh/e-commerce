import { defineStore } from 'pinia'
import { catalogueStatus, findProduct } from './catalog'
import type { CategoryId, Product } from '@/types'

/**
 * Which products are lined up for comparison.
 *
 * One category at a time, by design: a table whose columns are a phone and a
 * mouse has no row that means anything in both. The first product added locks
 * the category and `add` refuses anything else — the disabled checkbox on a
 * card is a courtesy so the shopper sees it coming, but this is the rule,
 * because a URL goes straight past the UI.
 */

const COMPARE_KEY = 'nexus:compare'

/** Four columns still read on a laptop; five need a scrollbar to say anything. */
export const MAX_COMPARE = 4

/**
 * Storage that cannot throw.
 *
 * Private windows and blocked site data raise on access, and a storefront that
 * cannot remember a selection must still render one.
 */
const stored = {
  read(): string[] {
    try {
      const raw = localStorage.getItem(COMPARE_KEY)
      const parsed = raw ? JSON.parse(raw) : []
      return Array.isArray(parsed) ? validIds(parsed) : []
    } catch {
      return []
    }
  },
  write(ids: string[]) {
    try {
      localStorage.setItem(COMPARE_KEY, JSON.stringify(ids))
    } catch {
      /* the selection still works for this session */
    }
  },
}

/**
 * The subset of `ids` that can actually form a comparison.
 *
 * Ids reach this from two places that are both outside the app's control — a
 * `?ids=` query someone can type, and whatever localStorage held from an older
 * build — so they are filtered rather than trusted. Unknown ids, duplicates,
 * anything from a second category and anything past the fourth are dropped. A
 * hand-edited URL produces a smaller comparison, never a broken page.
 */
export function validIds(ids: unknown[]): string[] {
  const out: string[] = []
  let category: CategoryId | null = null

  for (const raw of ids) {
    if (typeof raw !== 'string') continue
    if (out.includes(raw)) continue
    const product = findProduct(raw)
    if (!product) {
      // Until the live catalogue has answered, an unknown id may be a product
      // newer than the build-time snapshot. Hold it; main.ts re-validates when
      // live data arrives (never on a failed fetch, which proves nothing), and
      // `items` shows only what resolves meanwhile.
      if (catalogueStatus.value !== 'live') out.push(raw)
      if (out.length === MAX_COMPARE) break
      continue
    }
    if (category === null) category = product.category
    else if (product.category !== category) continue
    out.push(raw)
    if (out.length === MAX_COMPARE) break
  }
  return out
}

export const useCompareStore = defineStore('compare', {
  state: () => ({
    ids: stored.read(),
  }),

  getters: {
    items: (state): Product[] => state.ids.map(findProduct).filter((p): p is Product => Boolean(p)),

    /**
     * Derived from the first selection rather than stored beside it. Two fields
     * that have to agree are two fields that can disagree.
     */
    category(): CategoryId | null {
      return this.items[0]?.category ?? null
    },

    full: (state): boolean => state.ids.length >= MAX_COMPARE,

    /** Two columns is the minimum that compares anything. */
    ready: (state): boolean => state.ids.length >= 2,

    has: (state) => (id: string) => state.ids.includes(id),
  },

  actions: {
    /**
     * Whether this product could join the comparison.
     *
     * True for one already in it, because the control is a toggle and taking a
     * product back out is always allowed.
     */
    canAdd(product: Product): boolean {
      if (this.has(product.id)) return true
      if (this.full) return false
      return this.category === null || product.category === this.category
    },

    /** Returns whether the product is now in the comparison. */
    add(product: Product): boolean {
      if (this.has(product.id)) return true
      if (!this.canAdd(product)) return false
      this.ids = [...this.ids, product.id]
      return true
    },

    /**
     * Swaps the product in one column, or fills the first empty slot.
     *
     * The candidate list goes through `validIds` and is accepted only if
     * nothing was dropped, which is what keeps the category lock honest without
     * restating it here: swapping column 0 for another category would strand
     * every other column, so the shorter result is refused and the picker keeps
     * its old value. Column 0 alone can change category freely, because then
     * there is nothing to strand.
     */
    setAt(index: number, id: string): boolean {
      if (index < 0 || index > this.ids.length || index >= MAX_COMPARE) return false
      if (this.ids[index] === id) return true

      const next = [...this.ids]
      next[index] = id
      const valid = validIds(next)
      if (valid.length !== next.length) return false

      this.ids = valid
      return true
    },

    remove(id: string) {
      this.ids = this.ids.filter((x) => x !== id)
    },

    toggle(product: Product): boolean {
      if (this.has(product.id)) {
        this.remove(product.id)
        return false
      }
      return this.add(product)
    },

    clear() {
      this.ids = []
    },

    /** Adopts a list from outside the app — a shared link, or older storage. */
    setFromIds(ids: unknown[]) {
      this.ids = validIds(ids)
    },

    persist() {
      stored.write(this.ids)
    },
  },
})
