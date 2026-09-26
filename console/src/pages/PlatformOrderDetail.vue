<script setup lang="ts">
// One order as the platform sees it: every merchant's part, its lines, its
// refunds and how it moved. The platform may refund any line and cancel any
// pending part (the way out for a suspended merchant); the worker decides what
// is allowed, and its refusal is shown as it said it.
import { computed, onMounted, reactive, ref, watch } from 'vue'
import {
  platformOrder,
  platformRefund,
  cancelPart,
  merchantNames,
  isError,
  type ErrorBody,
  type MerchantName,
  type OrderLine,
  type PlatformOrderDetail,
} from '../api'
import { formatAmounts, formatMinor, parsePriceToMinor } from '../money'
import { FULFILMENT, METHOD, placed } from '../orders'

const props = defineProps<{ id: string }>()
const order = ref<PlatformOrderDetail | null>(null)
const merchants = ref<MerchantName[]>([])
const error = ref<string | null>(null)
const actionError = ref<string | null>(null)
const busy = ref(false)
const refunding = ref<string | null>(null)
const refund = reactive({ qty: 0, amount: '', reason: '' })

const nameOf = (id: string) => merchants.value.find((m) => m.id === id)?.name ?? id
const lineKey = (l: OrderLine) => `${l.productId}|${l.finish ?? ''}`
const leftMinor = (l: OrderLine) => l.qty * l.unitMinor - l.refundedMinor

/** One block per merchant: its part (if it has one), its lines and its refunds. */
const parts = computed(() => {
  const o = order.value
  if (!o) return []
  const ids = [...new Set([...o.fulfilment.map((f) => f.merchantId), ...o.lines.map((l) => l.merchantId)])].sort()
  return ids.map((merchantId) => {
    const lines = o.lines.filter((l) => l.merchantId === merchantId)
    const goods = new Map<string, number>()
    for (const l of lines) goods.set(l.currency, (goods.get(l.currency) ?? 0) + l.qty * l.unitMinor)
    return {
      merchantId,
      part: o.fulfilment.find((f) => f.merchantId === merchantId) ?? null,
      lines,
      goods: [...goods].map(([currency, minor]) => ({ currency, minor })),
      refunds: o.refunds.filter((r) => r.merchantId === merchantId),
    }
  })
})

/** Only the newest answer lands, so moving between orders never shows the previous one. */
let latest = 0
async function load() {
  const mine = ++latest
  error.value = null
  const { status, body } = await platformOrder(props.id)
  if (mine !== latest) return
  if (status === 404) error.value = 'No paid order with that number.'
  else if (isError(body)) error.value = body.error
  else if ('lines' in body) order.value = body
  else error.value = 'Something went wrong. Reload and try again.'
}

watch(() => props.id, load, { immediate: true })
onMounted(async () => (merchants.value = await merchantNames()))

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
    actionError.value = 'Could not reach the console. Check your connection, then reload to see where this order stands.'
    return false
  } finally {
    busy.value = false
  }
}

function cancel(merchantId: string) {
  if (
    !window.confirm(
      `Cancel ${nameOf(merchantId)}'s part of this order on its behalf?\n\n` +
        'Its items go back into stock and the customer is refunded for them in full. This is recorded as the platform\'s act and cannot be undone.',
    )
  ) {
    return
  }
  void act(() => cancelPart(props.id, merchantId))
}

function openRefund(l: OrderLine) {
  actionError.value = null
  refunding.value = lineKey(l)
  refund.qty = l.qty > l.refundedQty ? 1 : 0
  refund.amount = ''
  refund.reason = ''
}

async function submitRefund(l: OrderLine) {
  const amountMinor = refund.amount.trim() ? parsePriceToMinor(refund.amount) : undefined
  if (amountMinor === null) {
    actionError.value = 'The amount is a price such as 12.50.'
    return
  }
  const total = amountMinor ?? refund.qty * l.unitMinor
  if (!window.confirm(`Refund ${formatMinor(total, l.currency)} on ${l.title}, sold by ${nameOf(l.merchantId)}?\n\nIt comes off that merchant's balance. This cannot be undone.`)) return
  const done = await act(() =>
    platformRefund(props.id, { productId: l.productId, finish: l.finish, qty: refund.qty, amountMinor, reason: refund.reason.trim() }),
  )
  if (done) refunding.value = null
}
</script>

<template>
  <router-link to="/platform/orders" class="mb-4 inline-block text-sm text-text-secondary hover:text-text-primary">← All orders</router-link>

  <p v-if="error" class="text-sm text-accent-amber" role="alert">{{ error }}</p>
  <p v-else-if="!order" class="text-text-secondary">Loading…</p>
  <div v-else class="flex flex-col gap-6">
    <header class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
      <h1 class="font-mono text-lg font-medium text-text-primary">{{ order.id }}</h1>
      <span class="text-sm text-text-secondary">{{ placed(order.placedAt) }} UTC</span>
      <span class="text-sm text-text-secondary">{{ METHOD[order.method] ?? order.method }}</span>
      <span class="nums text-sm text-text-primary">Goods {{ formatAmounts(order.totals) }}</span>
    </header>

    <p v-if="actionError" class="text-sm text-accent-amber" role="alert">{{ actionError }}</p>

    <section class="card p-4">
      <h2 class="label mb-2">Ship to</h2>
      <address class="text-sm not-italic leading-relaxed text-text-primary">
        {{ order.shipTo.name }} · {{ order.shipTo.line1 }}<template v-if="order.shipTo.line2">, {{ order.shipTo.line2 }}</template>,
        {{ order.shipTo.city }}<template v-if="order.shipTo.state">, {{ order.shipTo.state }}</template> {{ order.shipTo.postal }}, {{ order.shipTo.country }}
      </address>
    </section>

    <section v-for="p in parts" :key="p.merchantId" class="card" :aria-label="`${nameOf(p.merchantId)}'s part`">
      <div class="flex flex-wrap items-center gap-3 border-b border-border-hairline p-4">
        <router-link :to="`/platform/merchants/${p.merchantId}`" class="font-medium text-text-primary hover:text-accent">{{ nameOf(p.merchantId) }}</router-link>
        <span v-if="p.part" class="rounded-full border px-2 py-0.5 text-xs" :class="FULFILMENT[p.part.status]?.badge">
          {{ FULFILMENT[p.part.status]?.label ?? p.part.status }}
        </span>
        <span class="nums ml-auto text-sm text-text-primary">{{ formatAmounts(p.goods) }}</span>
        <button v-if="p.part?.status === 'pending'" class="btn-ghost px-3 py-1.5 text-xs" :disabled="busy" @click="cancel(p.merchantId)">
          Cancel part
        </button>
      </div>

      <ol class="flex flex-wrap gap-x-6 gap-y-1 border-b border-border-hairline px-4 py-3 text-xs text-text-secondary" aria-label="Timeline">
        <li>Placed <span class="nums text-text-primary">{{ placed(order.placedAt) }}</span></li>
        <li v-if="p.part?.shippedAt">
          Shipped <span class="nums text-text-primary">{{ placed(p.part.shippedAt) }}</span> · {{ p.part.carrier }}
          <span class="font-mono">{{ p.part.tracking }}</span>
        </li>
        <li v-if="p.part?.deliveredAt">Delivered <span class="nums text-text-primary">{{ placed(p.part.deliveredAt) }}</span></li>
        <li v-if="p.part?.status === 'cancelled'">Cancelled <span class="nums text-text-primary">{{ placed(p.part.updatedAt) }}</span></li>
        <li v-for="r in p.refunds" :key="r.id">
          Refunded <span class="nums text-text-primary">{{ formatMinor(r.amountMinor, r.currency) }}</span>
          <span class="nums">{{ placed(r.at) }}</span> by {{ r.by }}: {{ r.reason }}
        </li>
      </ol>

      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="border-b border-border-hairline">
            <tr class="label">
              <th class="px-4 py-3 font-medium">Item</th>
              <th class="px-4 py-3 font-medium">Qty</th>
              <th class="px-4 py-3 text-right font-medium">Line</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="l in p.lines" :key="lineKey(l)">
              <tr class="border-b border-border-hairline last:border-0">
                <td class="px-4 py-3">
                  <p class="text-text-primary">{{ l.title }}</p>
                  <p class="code">{{ l.sku }}<template v-if="l.finish"> · {{ l.finish }}</template></p>
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
                <td class="nums whitespace-nowrap px-4 py-3 text-text-secondary">{{ l.qty }} × {{ formatMinor(l.unitMinor, l.currency) }}</td>
                <td class="nums whitespace-nowrap px-4 py-3 text-right text-text-primary">{{ formatMinor(l.unitMinor * l.qty, l.currency) }}</td>
              </tr>
              <tr v-if="refunding === lineKey(l)" class="border-b border-border-hairline bg-surface-2">
                <td colspan="3" class="px-4 py-3">
                  <form class="flex flex-wrap items-end gap-3" @submit.prevent="submitRefund(l)">
                    <div class="w-20">
                      <label class="label mb-1 block" :for="`pqty-${lineKey(l)}`">Units</label>
                      <input :id="`pqty-${lineKey(l)}`" v-model.number="refund.qty" class="input" type="number" min="0" :max="l.qty - l.refundedQty" required />
                    </div>
                    <div class="w-32">
                      <label class="label mb-1 block" :for="`pamount-${lineKey(l)}`">Amount ({{ l.currency }})</label>
                      <input :id="`pamount-${lineKey(l)}`" v-model="refund.amount" class="input" inputmode="decimal" :placeholder="formatMinor(refund.qty * l.unitMinor, l.currency)" />
                    </div>
                    <div class="min-w-[12rem] flex-1">
                      <label class="label mb-1 block" :for="`preason-${lineKey(l)}`">Reason</label>
                      <input :id="`preason-${lineKey(l)}`" v-model="refund.reason" class="input" required maxlength="200" />
                    </div>
                    <button class="btn-primary" type="submit" :disabled="busy">Refund</button>
                    <button class="btn-ghost" type="button" :disabled="busy" @click="refunding = null">Back</button>
                    <p class="nums w-full text-xs text-text-secondary">
                      Up to {{ formatMinor(leftMinor(l), l.currency) }} and {{ l.qty - l.refundedQty }} unit{{ l.qty - l.refundedQty === 1 ? '' : 's' }} left to refund.
                    </p>
                  </form>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
