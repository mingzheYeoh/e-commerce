<script setup lang="ts">
// Only this merchant's lines and their sum: the worker never sends another
// seller's lines or the order's grand total, so there is nothing here to hide.
// The actions below act on this merchant's part of the order only; the worker
// decides which transitions are legal and says so when one is not.
import { computed, onMounted, reactive, ref } from 'vue'
import {
  getOrder,
  shipOrder,
  deliverOrder,
  cancelOrder,
  refundLine,
  isError,
  type ErrorBody,
  type OrderDetail,
  type OrderLine,
} from '../api'
import { formatAmounts, formatMinor, parsePriceToMinor } from '../money'
import { FULFILMENT, METHOD, placed } from '../orders'

const props = defineProps<{ id: string }>()
const order = ref<OrderDetail | null>(null)
const error = ref<string | null>(null)
const actionError = ref<string | null>(null)
const busy = ref(false)

/** A merchant reads exactly one part: its own. */
const part = computed(() => order.value?.fulfilment[0] ?? null)
const shipping = reactive({ open: false, carrier: '', tracking: '' })
/** The line whose refund form is open, by its key. */
const refunding = ref<string | null>(null)
const refund = reactive({ qty: 0, amount: '', reason: '' })

const lineKey = (l: OrderLine) => `${l.productId}|${l.finish ?? ''}`
const leftMinor = (l: OrderLine) => l.qty * l.unitMinor - l.refundedMinor
const refunded = computed(() => {
  const by = new Map<string, number>()
  for (const l of order.value?.lines ?? []) {
    if (l.refundedMinor) by.set(l.currency, (by.get(l.currency) ?? 0) + l.refundedMinor)
  }
  return [...by].map(([currency, minor]) => ({ currency, minor }))
})

async function load() {
  const { status, body } = await getOrder(props.id)
  if (status === 404) error.value = 'No order of yours with that number.'
  else if (isError(body)) error.value = body.error
  else if ('lines' in body) order.value = body
  else error.value = 'Something went wrong. Reload and try again.'
}

onMounted(load)

/** Runs one action, shows the worker's refusal if there is one, and reloads on success. */
async function act(run: () => Promise<{ body: object | ErrorBody }>): Promise<boolean> {
  busy.value = true
  actionError.value = null
  try {
    const { body } = await run()
    if (isError(body)) {
      actionError.value = body.error
      return false
    }
    await load()
    return true
  } catch {
    // No answer at all (offline, a dropped connection): the change may or may
    // not have landed, so say that rather than nothing.
    actionError.value = 'Could not reach the console. Check your connection, then reload to see where this order stands.'
    return false
  } finally {
    busy.value = false
  }
}

async function ship() {
  if (await act(() => shipOrder(props.id, shipping.carrier.trim(), shipping.tracking.trim()))) shipping.open = false
}

const deliver = () => act(() => deliverOrder(props.id))

function cancel() {
  if (
    !window.confirm(
      'Cancel your part of this order?\n\n' +
        'Its items go back into stock and the customer is refunded for them in full. This cannot be undone.',
    )
  ) {
    return
  }
  void act(() => cancelOrder(props.id))
}

function openRefund(l: OrderLine) {
  actionError.value = null
  refunding.value = lineKey(l)
  refund.qty = l.qty > l.refundedQty ? 1 : 0
  refund.amount = ''
  refund.reason = ''
}

async function submitRefund(l: OrderLine) {
  // Typed in major units, sent in minor; left blank, the worker charges back qty × unit price.
  const amountMinor = refund.amount.trim() ? parsePriceToMinor(refund.amount) : undefined
  if (amountMinor === null) {
    actionError.value = 'The amount is a price such as 12.50.'
    return
  }
  const total = amountMinor ?? refund.qty * l.unitMinor
  if (!window.confirm(`Refund ${formatMinor(total, l.currency)} on ${l.title}?\n\nThis cannot be undone.`)) return
  const done = await act(() =>
    refundLine(props.id, { productId: l.productId, finish: l.finish, qty: refund.qty, amountMinor, reason: refund.reason.trim() }),
  )
  if (done) refunding.value = null
}
</script>

<template>
  <router-link to="/orders" class="mb-4 inline-block text-sm text-text-secondary hover:text-text-primary">← Orders</router-link>

  <p v-if="error" class="text-sm text-accent-amber">{{ error }}</p>
  <p v-else-if="!order" class="text-text-secondary">Loading…</p>
  <div v-else class="flex flex-col gap-6">
    <header class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
      <h1 class="font-mono text-lg font-medium text-text-primary">{{ order.id }}</h1>
      <span class="text-sm text-text-secondary">{{ placed(order.placedAt) }} UTC</span>
      <span
        v-if="part"
        class="rounded-full border px-2 py-0.5 text-xs"
        :class="FULFILMENT[part.status]?.badge"
      >{{ FULFILMENT[part.status]?.label ?? part.status }}</span>
    </header>

    <p v-if="actionError" class="text-sm text-accent-amber" role="alert">{{ actionError }}</p>

    <div class="grid grid-cols-1 gap-6 md:grid-cols-3">
      <div class="flex flex-col gap-6 md:col-span-1">
        <section class="card p-4">
          <h2 class="label mb-2">Ship to</h2>
          <address class="text-sm not-italic leading-relaxed text-text-primary">
            {{ order.shipTo.name }}<br />
            {{ order.shipTo.line1 }}<br />
            <template v-if="order.shipTo.line2">{{ order.shipTo.line2 }}<br /></template>
            {{ order.shipTo.city }}<template v-if="order.shipTo.state">, {{ order.shipTo.state }}</template>
            {{ order.shipTo.postal }}<br />
            {{ order.shipTo.country }}
          </address>
          <h2 class="label mb-1 mt-4">Delivery</h2>
          <p class="text-sm text-text-primary">{{ METHOD[order.method] ?? order.method }}</p>
        </section>

        <section v-if="part" class="card p-4">
          <h2 class="label mb-2">Fulfilment</h2>
          <dl class="flex flex-col gap-1 text-sm">
            <template v-if="part.carrier">
              <dt class="text-text-secondary">Carrier</dt>
              <dd class="text-text-primary">{{ part.carrier }}</dd>
              <dt class="text-text-secondary">Tracking</dt>
              <dd class="font-mono text-xs text-text-primary">{{ part.tracking }}</dd>
            </template>
            <template v-if="part.shippedAt">
              <dt class="text-text-secondary">Shipped</dt>
              <dd class="nums text-text-primary">{{ placed(part.shippedAt) }} UTC</dd>
            </template>
            <template v-if="part.deliveredAt">
              <dt class="text-text-secondary">Delivered</dt>
              <dd class="nums text-text-primary">{{ placed(part.deliveredAt) }} UTC</dd>
            </template>
            <dd v-if="part.status === 'cancelled'" class="text-text-secondary">
              Cancelled: the items went back into stock and were refunded.
            </dd>
          </dl>

          <form v-if="shipping.open" class="mt-4 flex flex-col gap-3" @submit.prevent="ship">
            <div>
              <label class="label mb-1 block" for="ship-carrier">Carrier</label>
              <input id="ship-carrier" v-model="shipping.carrier" class="input" required maxlength="60" placeholder="UPS" />
            </div>
            <div>
              <label class="label mb-1 block" for="ship-tracking">Tracking number</label>
              <input id="ship-tracking" v-model="shipping.tracking" class="input font-mono" required maxlength="60" />
            </div>
            <div class="flex gap-2">
              <button class="btn-primary" type="submit" :disabled="busy">Mark shipped</button>
              <button class="btn-ghost" type="button" :disabled="busy" @click="shipping.open = false">Back</button>
            </div>
          </form>
          <div v-else class="mt-4 flex flex-wrap gap-2">
            <template v-if="part.status === 'pending'">
              <button class="btn-primary" type="button" :disabled="busy" @click="shipping.open = true">Mark shipped</button>
              <button class="btn-ghost" type="button" :disabled="busy" @click="cancel">Cancel</button>
            </template>
            <button v-else-if="part.status === 'shipped'" class="btn-primary" type="button" :disabled="busy" @click="deliver">
              Mark delivered
            </button>
          </div>
        </section>
      </div>

      <section class="card md:col-span-2">
        <table class="w-full text-left text-sm">
          <thead class="border-b border-border-hairline">
            <tr class="label">
              <th class="px-4 py-3 font-medium">Your items</th>
              <th class="hidden px-4 py-3 font-medium sm:table-cell">Qty</th>
              <th class="hidden px-4 py-3 text-right font-medium sm:table-cell">Price</th>
              <th class="px-4 py-3 text-right font-medium">Line</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="l in order.lines" :key="lineKey(l)">
              <tr class="border-b border-border-hairline">
                <td class="px-4 py-3">
                  <p class="text-text-primary">{{ l.title }}</p>
                  <p class="code">{{ l.sku }}<template v-if="l.finish"> · {{ l.finish }}</template></p>
                  <p class="nums mt-1 text-xs text-text-secondary sm:hidden">{{ l.qty }} × {{ formatMinor(l.unitMinor, l.currency) }}</p>
                  <p v-if="l.refundedMinor" class="nums mt-1 text-xs text-accent-amber">
                    Refunded {{ formatMinor(l.refundedMinor, l.currency) }}<template v-if="l.refundedQty"> · {{ l.refundedQty }} unit{{ l.refundedQty === 1 ? '' : 's' }}</template>
                  </p>
                  <button
                    v-if="leftMinor(l) > 0 && refunding !== lineKey(l)"
                    class="mt-1 text-xs text-text-secondary underline hover:text-text-primary"
                    type="button"
                    :disabled="busy"
                    @click="openRefund(l)"
                  >
                    Refund
                  </button>
                </td>
                <td class="nums hidden px-4 py-3 text-text-secondary sm:table-cell">{{ l.qty }}</td>
                <td class="nums hidden px-4 py-3 text-right text-text-secondary sm:table-cell">{{ formatMinor(l.unitMinor, l.currency) }}</td>
                <td class="nums px-4 py-3 text-right text-text-primary">{{ formatMinor(l.unitMinor * l.qty, l.currency) }}</td>
              </tr>
              <tr v-if="refunding === lineKey(l)" class="border-b border-border-hairline bg-surface-2">
                <td colspan="4" class="px-4 py-3">
                  <form class="flex flex-wrap items-end gap-3" @submit.prevent="submitRefund(l)">
                    <div class="w-20">
                      <label class="label mb-1 block" :for="`qty-${lineKey(l)}`">Units</label>
                      <input :id="`qty-${lineKey(l)}`" v-model.number="refund.qty" class="input" type="number" min="0" :max="l.qty - l.refundedQty" required />
                    </div>
                    <div class="w-32">
                      <label class="label mb-1 block" :for="`amount-${lineKey(l)}`">Amount ({{ l.currency }})</label>
                      <input
                        :id="`amount-${lineKey(l)}`"
                        v-model="refund.amount"
                        class="input"
                        inputmode="decimal"
                        :placeholder="formatMinor(refund.qty * l.unitMinor, l.currency)"
                      />
                    </div>
                    <div class="min-w-[12rem] flex-1">
                      <label class="label mb-1 block" :for="`reason-${lineKey(l)}`">Reason</label>
                      <input :id="`reason-${lineKey(l)}`" v-model="refund.reason" class="input" required maxlength="200" />
                    </div>
                    <button class="btn-primary" type="submit" :disabled="busy">Refund</button>
                    <button class="btn-ghost" type="button" :disabled="busy" @click="refunding = null">Back</button>
                    <p class="nums w-full text-xs text-text-secondary">
                      Up to {{ formatMinor(leftMinor(l), l.currency) }} and {{ l.qty - l.refundedQty }} unit{{ l.qty - l.refundedQty === 1 ? '' : 's' }} left
                      to refund. Leave the amount blank to refund the units at their price.
                    </p>
                  </form>
                </td>
              </tr>
            </template>
          </tbody>
          <tfoot>
            <tr>
              <td colspan="4" class="px-4 py-3">
                <div class="flex items-baseline justify-end gap-4">
                  <span class="text-text-secondary">Your total</span>
                  <span class="nums font-semibold text-text-primary">{{ formatAmounts(order.totals) }}</span>
                </div>
                <div v-if="refunded.length" class="mt-1 flex items-baseline justify-end gap-4">
                  <span class="text-text-secondary">Refunded</span>
                  <span class="nums text-accent-amber">{{ formatAmounts(refunded) }}</span>
                </div>
              </td>
            </tr>
          </tfoot>
        </table>
      </section>
    </div>
  </div>
</template>
