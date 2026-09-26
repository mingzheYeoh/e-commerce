import { defineStore } from 'pinia'
import { useCartStore, lineKey, type CartLine } from './cart'
import { chargeCard, cardProblem, settle, CHANNELS, type PayMethod, type SimOutcome } from '@/lib/payment'
import { totalCents, type OrderTotals, type ShipMethod } from '@/lib/money'
import { findCountry, validSubdivision, validPostal, validPhone } from '@/lib/regions'
import { methodAvailable, defaultMethodFor } from '@/lib/shipping'
import { saveOrder, fetchOrder, type OrderPart, type OrderPayment, type RemoteOrder } from '@/lib/api'
import { catalogue, catalogueReady, findProduct } from './catalog'
import { useUiStore } from './ui'

/**
 * Checkout state and order placement.
 *
 * The rule that matters most is at the bottom of `place()`: the cart is cleared
 * only after a charge succeeds AND the server has stored the order. Written the
 * other way round, one declined card — or one sold-out item — empties a
 * shopper's basket, which is the sort of bug that is obvious in hindsight and
 * invisible in review, so each has a test of its own.
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

/** A line of a placed order: what was bought, and — once the server says — who sells it and how far it got. */
export type OrderLine = CartLine & {
  seller?: string
  /** That seller's part. Null or absent unless the signed-in account placed the order. */
  status?: OrderPart['status'] | null
}

export interface Order {
  id: string
  placedAt: string
  address: Address
  method: ShipMethod
  lines: OrderLine[]
  /** Frozen at purchase. Recomputing later would rewrite history on a price change. */
  totals: OrderTotals
  paymentCode: string
  /** How it was paid. Absent on a receipt stored before payment methods. */
  payment?: OrderPayment
}

const ORDERS_KEY = 'nexus:orders'
const ATTEMPT_KEY = 'nexus:checkout-attempt'

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
    payMethod: 'card' as PayMethod,
    /** The FPX bank or e-wallet chosen. A card's brand is read off its number instead. */
    channel: '',
    /** Never sent anywhere: only the brand the number implies leaves this store. */
    card: { number: '', expiry: '', cvc: '' },
    placing: false,
    error: '',
    orders: safeStorage.read<Order[]>(ORDERS_KEY, []),
    /** Order id -> whether the durable copy was written. Surfaced on the receipt. */
    synced: {} as Record<string, boolean>,
    /**
     * The id an unanswered attempt used, and the request it was for, so a
     * retry can reuse it. Kept in storage, because the likeliest thing a
     * shopper does after "we could not confirm your order" is reload.
     */
    attempt: safeStorage.read<{ id: string; key: string } | null>(ATTEMPT_KEY, null),
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
      if (this.payMethod === 'card') return cardProblem(this.card) === null
      return CHANNELS[this.payMethod].includes(this.channel)
    },

    /** A bank chosen for FPX is not a wallet, so switching method starts the choice again. */
    setPayMethod(method: PayMethod) {
      if (this.payMethod === method) return
      this.payMethod = method
      this.channel = ''
      this.error = ''
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

    setAttempt(attempt: { id: string; key: string } | null) {
      this.attempt = attempt
      safeStorage.write(ATTEMPT_KEY, attempt)
    },

    findOrder(id: string): Order | undefined {
      return this.orders.find((o) => o.id === id)
    },

    /**
     * Pays and places the order. For FPX and e-wallets `outcome` is what the
     * simulator screen reported; anything but an approval stops here, the way
     * a declined card does, and posts nothing.
     */
    async place(outcome?: SimOutcome): Promise<{ ok: true; id: string } | { ok: false }> {
      // A second press while the first is still in flight is not a second order.
      if (this.placing) return { ok: false }
      const cart = useCartStore()
      this.error = ''
      // Price and availability are checked against the live list, not a
      // snapshot it is about to replace. `placing` covers the wait so the pay
      // button cannot fire a second order while the fetch is in flight.
      // The total the shopper is looking at when they press Pay. If the live
      // list lands during the wait and moves a price, they review the new
      // figure rather than being charged one they never saw.
      const shown = this.totals.total
      this.placing = true
      try {
        await catalogueReady()
      } finally {
        this.placing = false
      }

      if (!cart.items.length) {
        this.error = 'Your cart is empty.'
        return { ok: false }
      }
      if (!this.stepValid(1)) {
        this.error = 'Delivery details are incomplete.'
        return { ok: false }
      }
      if (cart.hasUnavailable) {
        this.error = 'Some items are no longer available. Remove them to continue.'
        return { ok: false }
      }
      if (this.totals.total !== shown) {
        this.error = 'Prices were updated. Please review your order before paying.'
        return { ok: false }
      }

      this.placing = true
      // A real gateway takes a moment; pretending it is instant makes the
      // pending state untestable and the UI feel wrong.
      await new Promise((r) => setTimeout(r, 400))

      const card = this.payMethod === 'card' ? chargeCard(this.card) : null
      const result = card ?? settle(outcome ?? 'cancelled')
      // A card's brand, or the bank or wallet chosen. The number never leaves.
      const channel = card ? (card.brand ?? '') : this.channel

      if (!result.ok) {
        this.placing = false
        // Stay put. The form keeps its values and the cart keeps its contents:
        // a decline is something to retry, not a reason to start over.
        this.error = result.message
        return { ok: false }
      }

      const request = {
        address: { ...this.address },
        method: this.method,
        // Catalogue ids, quantities and the chosen finish. Still no prices:
        // the server prices the order from its own catalogue, and it checks the
        // finish against that product's colourways rather than taking the word
        // for it. The id rather than the sku, because two merchants may list one
        // sku and the server would be guessing which one was bought.
        lines: cart.lines.map((l) => ({ productId: l.productId, qty: l.qty, finish: l.finish })),
        paymentCode: result.code,
        paymentMethod: this.payMethod,
        paymentChannel: channel,
        currency: useUiStore().currency,
      }
      /*
       * The same basket to the same address by the same method, retried after
       * an attempt that got no answer, keeps that attempt's id — across a
       * reload too, since the attempt is kept in storage. If the first one did
       * land, the server answers with that stored order and this is the same
       * order, not a second one. Anything changed, and it is a new order with
       * a new id. The display currency is not part of it: switching it changes
       * no money the server charges.
       */
      const key = JSON.stringify({ address: request.address, method: request.method, lines: request.lines })
      const retry = this.attempt?.key === key
      const id = retry ? this.attempt!.id : orderId()
      this.setAttempt({ id, key })

      // Waited for, unlike before: the server is what takes the stock, so a
      // receipt written ahead of its answer could promise goods it refused.
      const saved = await saveOrder({ id, ...request })
      this.placing = false

      // The server already held this id. For a retry that is this order; for a
      // fresh id it is a stranger's, and nothing of this checkout was placed.
      if (saved.ok && saved.existing && !retry) {
        this.setAttempt(null)
        this.error = 'Something went wrong placing your order. Please press Pay again.'
        return { ok: false }
      }

      // "Already exists" is success only for a retry of this same request.
      if (!saved.ok && !(saved.reason === 'refused' && saved.duplicate && retry)) {
        // Stay on the checkout with the cart intact, and say what happened.
        if (saved.reason === 'unreachable') {
          this.error = 'We could not confirm your order. Check your connection and press Pay again: it will not be placed twice.'
        } else if (saved.duplicate) {
          // A fresh id that happened to be taken: draw another next time.
          this.setAttempt(null)
          this.error = 'Something went wrong placing your order. Please press Pay again.'
        } else if (saved.status === 409 || saved.status === 400) {
          // Sold out, or a basket the catalogue no longer agrees with. The
          // server's own words name the product.
          this.setAttempt(null)
          this.error = saved.error || 'Some items are no longer available. Review your cart to continue.'
        } else if (saved.status === 429) {
          this.error = saved.error || 'Too many orders from this connection. Try again in a minute.'
        } else {
          this.error = 'We could not place your order just now. Your cart is saved: try again in a moment.'
        }
        return { ok: false }
      }
      this.setAttempt(null)

      const order: Order = {
        id,
        placedAt: new Date().toISOString(),
        address: request.address,
        method: this.method,
        // The live-priced lines, so the receipt shows what the server charges.
        lines: cart.lines.map(({ available: _a, limited: _l, ...line }) => line),
        // The server's figures where it gave them: for a retry of an order that
        // already landed, they are what was charged then, not what this page
        // would work out now.
        totals: (saved.ok && saved.totals) || this.totals,
        paymentCode: result.code,
        // The server's record, with the reference it minted; for a retry, the
        // payment the stored order was placed with.
        payment: (saved.ok && saved.payment) || { method: this.payMethod, channel, ref: null },
      }

      this.orders = [order, ...this.orders].slice(0, 20)
      safeStorage.write(ORDERS_KEY, this.orders)
      this.synced[order.id] = true

      // Only now, once the server has the order. Clearing any earlier would
      // cost a shopper their basket every time a card or the stock said no.
      cart.items = []
      this.card = { number: '', expiry: '', cvc: '' }
      this.step = 1

      return { ok: true, id: order.id }
    },

    /**
     * The order behind a confirmation URL.
     *
     * Local first: the browser that placed it holds the full record, including
     * the unmasked email. Falling back to the API is what makes the link
     * shareable rather than a bookmark that only works on one machine.
     *
     * `remote`, when the caller already fetched it, saves a second request and
     * adds what only the server knows to a local receipt: each line's seller
     * and delivery status, and the payment reference. Without it a local
     * receipt is answered with no request at all.
     */
    async loadOrder(id: string, remote?: RemoteOrder | null): Promise<Order | null> {
      const local = this.findOrder(id)
      if (local) {
        if (!remote) return local
        const server = new Map(remote.lines.map((l) => [lineKey({ productId: l.productId ?? '', finish: l.finish }), l]))
        return {
          ...local,
          lines: local.lines.map((l) => {
            const s = server.get(lineKey(l))
            return s ? { ...l, seller: s.seller, status: s.status } : l
          }),
          payment: remote.payment?.ref ? remote.payment : (local.payment ?? remote.payment),
        }
      }

      const found = remote === undefined ? await fetchOrder(id) : remote
      if (!found) return null
      // It came back from the server, so it is by definition the durable copy.
      this.synced[id] = true
      return fromRemote(found)
    },
  },
})

/**
 * A server's copy of an order as the storefront renders it.
 *
 * Imagery is catalogue data, not order data, so it is looked up rather than
 * stored — a product that has since been delisted simply renders without a
 * thumbnail.
 */
export function fromRemote(remote: RemoteOrder): Order {
  const bySku = new Map(catalogue.value.map((p) => [p.sku, p]))
  return {
    id: remote.id,
    placedAt: remote.placedAt,
    address: { ...remote.address, email: remote.email },
    method: remote.method as ShipMethod,
    lines: remote.lines.map((l) => {
      // By id where the server sent one. An older API sent only the sku, and
      // a delisted product then falls back to its sku as the key rather than
      // to a key every such line shares.
      const p = l.productId ? findProduct(l.productId) : bySku.get(l.sku)
      return {
        productId: l.productId ?? p?.id ?? l.sku,
        sku: l.sku,
        title: l.title,
        finish: l.finish,
        brand: p?.brand ?? '',
        thumb: p?.media.thumb ?? '',
        unitPriceCents: l.unitPriceCents,
        qty: l.qty,
        stockCount: p?.stockCount ?? 0,
        seller: l.seller,
        status: l.status,
      }
    }),
    totals: remote.totals,
    paymentCode: remote.paymentCode,
    payment: remote.payment,
  }
}
