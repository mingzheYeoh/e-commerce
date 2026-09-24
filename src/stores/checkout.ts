import { defineStore } from 'pinia'
import { useCartStore, type CartLine } from './cart'
import { charge } from '@/lib/payment'
import { totalCents, type OrderTotals, type ShipMethod } from '@/lib/money'
import { findCountry, validSubdivision, validPostal, validPhone } from '@/lib/regions'
import { methodAvailable, defaultMethodFor } from '@/lib/shipping'
import { saveOrder, fetchOrder } from '@/lib/api'
import { products } from '@/data/products'
import { useUiStore } from './ui'

/**
 * Checkout state and order placement.
 *
 * The rule that matters most is at the bottom of `place()`: the cart is cleared
 * only after a charge succeeds. Written the other way round, one declined card
 * empties a shopper's basket — which is the sort of bug that is obvious in
 * hindsight and invisible in review, so it has a test of its own.
 */

export interface Address {
  name: string
  email: string
  /** Optional. Couriers ask for one; refusing an order without it does not. */
  phone: string
  /** ISO 3166-1 alpha-2. Drives the subdivision list, the postcode rule and the tax. */
  country: string
  line1: string
  /** Apartment, suite, floor. Optional, and most of the world needs it. */
  line2: string
  city: string
  /** State, province or territory — empty for countries that have none. */
  state: string
  postal: string
}

export interface Order {
  id: string
  placedAt: string
  address: Address
  method: ShipMethod
  lines: CartLine[]
  /** Frozen at purchase. Recomputing later would rewrite history on a price change. */
  totals: OrderTotals
  paymentCode: string
}

const ORDERS_KEY = 'nexus:orders'

/**
 * Storage that cannot throw.
 *
 * Private windows, blocked site data and storage quotas all raise on access.
 * A storefront that cannot write a receipt should still render.
 */
const safeStorage = {
  read<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key)
      return raw ? (JSON.parse(raw) as T) : fallback
    } catch {
      return fallback
    }
  },
  write(key: string, value: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      /* nothing to do; the order still exists in memory for this session */
    }
  },
}

const required = (v: string) => v.trim().length > 0
const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim())

/** NX-7K2M9: short enough to read aloud, unambiguous in print. */
function orderId(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no I, O, 0, 1
  let out = ''
  for (let i = 0; i < 5; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)]
  return `NX-${out}`
}

export const useCheckoutStore = defineStore('checkout', {
  state: () => ({
    step: 1 as 1 | 2 | 3,
    address: {
      name: '',
      email: '',
      phone: '',
      // Preselected because the tax model is built around it, and an empty
      // country means an empty subdivision list — a first field that offers
      // nothing reads as broken.
      country: 'US',
      line1: '',
      line2: '',
      city: '',
      state: '',
      postal: '',
    } as Address,
    method: 'standard' as ShipMethod,
    card: { number: '', expiry: '', cvc: '' },
    placing: false,
    error: '',
    orders: safeStorage.read<Order[]>(ORDERS_KEY, []),
    /** Order id -> whether the durable copy was written. Surfaced on the receipt. */
    synced: {} as Record<string, boolean>,
  }),

  getters: {
    totals(state): OrderTotals {
      const cart = useCartStore()
      return totalCents({
        subtotal: cart.subtotalCents,
        method: state.method,
        country: state.address.country,
        state: state.address.state,
      })
    },
  },

  actions: {
    /** Whether a step is complete enough to leave. */
    stepValid(step: 1 | 2 | 3): boolean {
      const a = this.address
      if (step === 1) {
        return (
          required(a.name) &&
          isEmail(a.email) &&
          validPhone(a.phone) &&
          Boolean(findCountry(a.country)) &&
          required(a.line1) &&
          required(a.city) &&
          // Not `required`: Singapore has no subdivision, so an empty one is
          // the correct answer there and a missing one everywhere else.
          validSubdivision(a.country, a.state) &&
          validPostal(a.country, a.postal)
        )
      }
      // Not just "a method is selected" — it has to be one this destination
      // actually has, which a change of country can invalidate.
      if (step === 2) return methodAvailable(this.method, a.country)
      return this.card.number.replace(/[\s-]/g, '').length >= 12
    },

    /** Furthest step the shopper has earned, so a deep link cannot skip ahead. */
    highestReachable(): 1 | 2 | 3 {
      if (!this.stepValid(1)) return 1
      if (!this.stepValid(2)) return 2
      return 3
    },

    /**
     * Changes the destination country, and drops what belonged to the old one.
     *
     * A subdivision code and a postcode format each belong to exactly one
     * country. Carrying "OR" into Malaysia leaves an address that validates
     * nowhere, and — worse — leaves a tax line quoting a state the order is not
     * going to.
     */
    setCountry(code: string) {
      if (this.address.country === code) return
      this.address.country = code
      this.address.state = ''
      this.address.postal = ''

      // The delivery method belongs to the old destination too. Overnight is a
      // US service; carried into Malaysia it would bill $29.95 for something
      // no carrier runs.
      if (!methodAvailable(this.method, code)) this.method = defaultMethodFor(code)
    },

    goTo(step: 1 | 2 | 3) {
      this.error = ''
      this.step = Math.min(step, this.highestReachable()) as 1 | 2 | 3
    },

    next() {
      if (this.stepValid(this.step) && this.step < 3) this.step = (this.step + 1) as 1 | 2 | 3
    },

    findOrder(id: string): Order | undefined {
      return this.orders.find((o) => o.id === id)
    },

    async place(): Promise<{ ok: true; id: string } | { ok: false }> {
      const cart = useCartStore()
      this.error = ''

      if (!cart.items.length) {
        this.error = 'Your cart is empty.'
        return { ok: false }
      }
      if (!this.stepValid(1)) {
        this.error = 'Delivery details are incomplete.'
        return { ok: false }
      }

      this.placing = true
      // A real gateway takes a moment; pretending it is instant makes the
      // pending state untestable and the UI feel wrong.
      await new Promise((r) => setTimeout(r, 400))

      const result = charge(this.card.number)
      this.placing = false

      if (!result.ok) {
        // Stay put. The form keeps its values and the cart keeps its contents:
        // a decline is something to retry, not a reason to start over.
        this.error = result.message
        return { ok: false }
      }

      const order: Order = {
        id: orderId(),
        placedAt: new Date().toISOString(),
        address: { ...this.address },
        method: this.method,
        lines: cart.items.map((line) => ({ ...line })),
        totals: this.totals,
        paymentCode: result.code,
      }

      this.orders = [order, ...this.orders].slice(0, 20)
      safeStorage.write(ORDERS_KEY, this.orders)

      // Only now. Clearing before the charge would cost a shopper their basket
      // every time a card was refused.
      cart.items = []
      this.card = { number: '', expiry: '', cvc: '' }
      this.step = 1

      // The durable copy, so /order/NX-4K2P9 opens on a device that never saw
      // this checkout. Deliberately not awaited into the result: the receipt
      // above is already written, and a database outage must not turn a
      // completed purchase into an error message.
      void saveOrder({
        id: order.id,
        address: order.address,
        method: order.method,
        // Catalogue ids, quantities and the chosen finish. Still no prices:
        // the server prices the order from its own catalogue, and it checks the
        // finish against that product's colourways rather than taking the word
        // for it. The id rather than the sku, because two merchants may list one
        // sku and the server would be guessing which one was bought.
        lines: order.lines.map((l) => ({ productId: l.productId, qty: l.qty, finish: l.finish })),
        paymentCode: order.paymentCode,
        currency: useUiStore().currency,
      }).then((stored) => {
        this.synced[order.id] = stored
      })

      return { ok: true, id: order.id }
    },

    /**
     * The order behind a confirmation URL.
     *
     * Local first: the browser that placed it holds the full record, including
     * the unmasked email. Falling back to the API is what makes the link
     * shareable rather than a bookmark that only works on one machine.
     */
    async loadOrder(id: string): Promise<Order | null> {
      const local = this.findOrder(id)
      if (local) return local

      const remote = await fetchOrder(id)
      if (!remote) return null
      // It came back from the server, so it is by definition the durable copy.
      this.synced[id] = true

      const bySku = new Map(products.map((p) => [p.sku, p]))
      return {
        id: remote.id,
        placedAt: remote.placedAt,
        address: { ...remote.address, email: remote.email },
        method: remote.method as ShipMethod,
        lines: remote.lines.map((l) => {
          // Imagery is catalogue data, not order data, so it is looked up
          // rather than stored — a product that has since been delisted simply
          // renders without a thumbnail.
          const p = bySku.get(l.sku)
          return {
            // A stored order keeps the sku, not the catalogue id, so this is the
            // one place a sku lookup is still all there is. It feeds the render
            // key and nothing that costs money, and a delisted product falls
            // back to its sku rather than to a key every such line shares.
            productId: p?.id ?? l.sku,
            sku: l.sku,
            title: l.title,
            finish: l.finish,
            brand: p?.brand ?? '',
            thumb: p?.media.thumb ?? '',
            unitPriceCents: l.unitPriceCents,
            qty: l.qty,
            stockCount: p?.stockCount ?? 0,
          }
        }),
        totals: remote.totals,
        paymentCode: remote.paymentCode,
      }
    },
  },
})
