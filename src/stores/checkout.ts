import { defineStore } from 'pinia'
import { useCartStore, type CartLine } from './cart'
import { charge } from '@/lib/payment'
import { totalCents, type OrderTotals, type ShipMethod } from '@/lib/money'

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
  line1: string
  city: string
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
const isPostal = (v: string) => /^\d{5}(-\d{4})?$/.test(v.trim())

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
    address: { name: '', email: '', line1: '', city: '', state: '', postal: '' } as Address,
    method: 'standard' as ShipMethod,
    card: { number: '', expiry: '', cvc: '' },
    placing: false,
    error: '',
    orders: safeStorage.read<Order[]>(ORDERS_KEY, []),
  }),

  getters: {
    totals(state): OrderTotals {
      const cart = useCartStore()
      return totalCents({
        subtotal: cart.subtotalCents,
        method: state.method,
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
          required(a.line1) &&
          required(a.city) &&
          required(a.state) &&
          isPostal(a.postal)
        )
      }
      if (step === 2) return Boolean(this.method)
      return this.card.number.replace(/[\s-]/g, '').length >= 12
    },

    /** Furthest step the shopper has earned, so a deep link cannot skip ahead. */
    highestReachable(): 1 | 2 | 3 {
      if (!this.stepValid(1)) return 1
      if (!this.stepValid(2)) return 2
      return 3
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

      return { ok: true, id: order.id }
    },
  },
})
