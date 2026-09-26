<script setup lang="ts">
// Money in and out across the platform: what shoppers were charged, refunds
// and payouts, newest first. Totals are the worker's, over the whole filter,
// per currency. An order whose lines span currencies is charged in none (XXX):
// its shipping and tax cannot be put in either.
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Download } from 'lucide-vue-next'
import {
  payments,
  merchantNames,
  isError,
  type MerchantName,
  type PaymentEntry,
  type PaymentFilter,
  type PaymentKind,
  type PaymentTotals,
} from '../api'
import { formatMinor, minorToDecimal } from '../money'
import { placed } from '../orders'
import { presetRange } from '../dates'
import { download, type Cell } from '../csv'

const route = useRoute()
const router = useRouter()

const KIND: Record<PaymentKind, string> = { charge: 'Charge', refund: 'Refund', payout: 'Payout' }
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const month = presetRange('30')
const filter = computed<PaymentFilter>(() => ({
  type: str(route.query.type) as PaymentKind | '',
  merchant: str(route.query.merchant),
  currency: str(route.query.currency),
  from: str(route.query.from) || month.from,
  to: str(route.query.to) || month.to,
}))
const form = ref({ type: '', merchant: '', currency: '', from: '', to: '' })

const merchants = ref<MerchantName[]>([])
const nameOf = (id: string) => merchants.value.find((m) => m.id === id)?.name ?? id
onMounted(async () => (merchants.value = await merchantNames()))

const entries = ref<PaymentEntry[]>([])
const totals = ref<PaymentTotals[]>([])
const next = ref<string | null>(null)
const error = ref<string | null>(null)
const loading = ref(true)
const more = ref(false)
const exporting = ref(false)

/** Only the newest request may land: a slow answer to an older filter, or an old Load more, is dropped. */
let latest = 0
async function load(before: string | null = null) {
  const mine = ++latest
  error.value = null
  if (before) more.value = true
  else loading.value = true
  const { body } = await payments({ ...filter.value, before })
  if (mine !== latest) return
  if (isError(body)) error.value = body.error
  else if ('entries' in body) {
    entries.value = before ? [...entries.value, ...body.entries] : body.entries
    totals.value = body.totals
    next.value = body.next
  } else error.value = 'Something went wrong. Reload and try again.'
  loading.value = false
  more.value = false
}

watch(
  filter,
  (f) => {
    if (route.path !== '/platform/payments') return
    form.value = { type: f.type ?? '', merchant: f.merchant ?? '', currency: f.currency ?? '', from: f.from ?? '', to: f.to ?? '' }
    void load()
  },
  { immediate: true },
)

const apply = () => {
  const q = Object.fromEntries(Object.entries({ ...form.value, currency: form.value.currency.trim().toUpperCase() }).filter(([, v]) => v))
  void router.replace({ query: q })
}

const METHOD: Record<NonNullable<PaymentEntry['paymentMethod']>, string> = { card: 'Card', fpx: 'FPX', ewallet: 'E-wallet' }
/** "FPX · Maybank2u" for a charge; empty for a refund or payout. */
const paidBy = (e: PaymentEntry) =>
  e.paymentMethod ? [METHOD[e.paymentMethod], e.paymentChannel].filter(Boolean).join(' · ') : ''
const who = (e: PaymentEntry) => e.merchantIds.map(nameOf).join(', ')
const parts = (e: PaymentEntry) =>
  e.kind === 'charge' && e.shipping !== null ? `goods ${formatMinor(e.goods ?? 0, e.currency)} · shipping ${formatMinor(e.shipping ?? 0, e.currency)} · tax ${formatMinor(e.tax ?? 0, e.currency)}` : ''

async function exportCsv() {
  exporting.value = true
  error.value = null
  const rows: Cell[][] = [['Date (UTC)', 'Type', 'Order or reference', 'Merchants', 'Currency', 'Amount', 'Goods', 'Shipping', 'Tax', 'Payment method', 'Payment channel']]
  let before: string | null = null
  const dec = (v: number | null) => (v === null ? null : minorToDecimal(v))
  // One filter for the whole export, whatever the page's does meanwhile.
  const f = { ...filter.value }
  try {
    do {
      const { body } = await payments({ ...f, before, limit: 200 })
      if (!('entries' in body)) {
        error.value = isError(body) ? body.error : 'The export stopped part way. Try again.'
        return
      }
      for (const e of body.entries) rows.push([e.at, KIND[e.kind], e.ref, who(e), e.currency, minorToDecimal(e.amount), dec(e.goods), dec(e.shipping), dec(e.tax), e.paymentMethod ? METHOD[e.paymentMethod] : null, e.paymentChannel])
      before = body.next
    } while (before)
    download(`payments-${f.from}-to-${f.to}.csv`, rows)
  } finally {
    exporting.value = false
  }
}
</script>

<template>
  <div class="mb-6 flex flex-wrap items-center justify-between gap-3">
    <h1 class="font-display text-xl font-bold text-text-primary">Payments</h1>
    <button class="btn-ghost inline-flex items-center gap-2 px-3 py-2" :disabled="exporting || loading" @click="exportCsv">
      <Download class="h-4 w-4" aria-hidden="true" />{{ exporting ? 'Exporting…' : 'Export CSV' }}
    </button>
  </div>

  <form class="mb-6 flex flex-wrap items-end gap-3" @submit.prevent="apply">
    <div class="min-w-[8rem] flex-1 sm:flex-none">
      <label class="label mb-1 block" for="pay-type">Type</label>
      <select id="pay-type" v-model="form.type" class="input">
        <option value="">Everything</option>
        <option value="charge">Charges</option>
        <option value="refund">Refunds</option>
        <option value="payout">Payouts</option>
      </select>
    </div>
    <div class="min-w-[10rem] flex-1 sm:flex-none">
      <label class="label mb-1 block" for="pay-merchant">Merchant</label>
      <select id="pay-merchant" v-model="form.merchant" class="input">
        <option value="">All merchants</option>
        <option v-for="m in merchants" :key="m.id" :value="m.id">{{ m.name }}</option>
      </select>
    </div>
    <div class="w-24">
      <label class="label mb-1 block" for="pay-currency">Currency</label>
      <input id="pay-currency" v-model="form.currency" class="input uppercase" maxlength="3" placeholder="All" />
    </div>
    <div class="min-w-[9rem] flex-1 sm:flex-none">
      <label class="label mb-1 block" for="pay-from">From</label>
      <input id="pay-from" v-model="form.from" class="input" type="date" required />
    </div>
    <div class="min-w-[9rem] flex-1 sm:flex-none">
      <label class="label mb-1 block" for="pay-to">To</label>
      <input id="pay-to" v-model="form.to" class="input" type="date" required />
    </div>
    <button class="btn-primary" type="submit" :disabled="loading">Show</button>
  </form>

  <p v-if="filter.merchant" class="mb-4 text-xs text-text-secondary">
    Filtered to one merchant: charges show only this merchant's goods; shipping and tax belong to the whole order.
  </p>
  <p v-if="error" class="mb-4 text-sm text-accent-amber" role="alert">{{ error }}</p>
  <p v-if="loading" class="text-text-secondary">Loading…</p>
  <template v-else-if="!error">
    <section v-if="totals.length" class="mb-6 grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3" aria-label="Totals">
      <div v-for="t in totals" :key="t.currency" class="card p-4">
        <p class="label mb-2">{{ t.currency }}<template v-if="t.currency === 'XXX'"> (orders in more than one currency)</template></p>
        <dl class="nums grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <dt class="text-text-secondary">Charged · {{ t.charges }}</dt>
          <dd class="text-right text-text-primary">{{ formatMinor(t.charged, t.currency) }}</dd>
          <dt class="text-text-secondary">of which goods</dt>
          <dd class="text-right text-text-secondary">{{ formatMinor(t.goods, t.currency) }}</dd>
          <template v-if="!filter.merchant">
            <dt class="text-text-secondary">shipping + tax</dt>
            <dd class="text-right text-text-secondary">{{ formatMinor(t.shipping + t.tax, t.currency) }}</dd>
          </template>
          <dt class="text-text-secondary">Refunded · {{ t.refunds }}</dt>
          <dd class="text-right text-text-primary">−{{ formatMinor(t.refunded, t.currency) }}</dd>
          <dt class="text-text-secondary">Paid out · {{ t.payouts }}</dt>
          <dd class="text-right text-text-primary">−{{ formatMinor(t.paidOut, t.currency) }}</dd>
        </dl>
      </div>
    </section>

    <p v-if="entries.length === 0" class="card p-6 text-text-secondary">Nothing matches in this range.</p>
    <template v-else>
      <div class="card overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="border-b border-border-hairline">
            <tr class="label">
              <th class="px-4 py-3 font-medium">Date (UTC)</th>
              <th class="px-4 py-3 font-medium">Type</th>
              <th class="px-4 py-3 font-medium">Order or reference</th>
              <th class="px-4 py-3 font-medium">Merchants</th>
              <th class="px-4 py-3 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="e in entries" :key="`${e.kind}-${e.id}`" class="border-b border-border-hairline last:border-0">
              <td class="nums whitespace-nowrap px-4 py-3 text-text-secondary">{{ placed(e.at) }}</td>
              <td class="px-4 py-3 text-text-secondary">{{ KIND[e.kind] }}</td>
              <td class="px-4 py-3">
                <router-link v-if="e.kind !== 'payout'" :to="`/platform/orders/${e.ref}`" class="font-mono text-xs text-accent hover:text-accent-hover">{{ e.ref }}</router-link>
                <span v-else class="text-text-primary">{{ e.ref }}</span>
                <p v-if="parts(e)" class="nums mt-0.5 whitespace-nowrap text-xs text-text-muted">{{ parts(e) }}</p>
                <p v-if="paidBy(e)" class="mt-0.5 whitespace-nowrap text-xs text-text-secondary">{{ paidBy(e) }}</p>
              </td>
              <td class="px-4 py-3 text-text-primary">{{ who(e) }}</td>
              <td class="nums whitespace-nowrap px-4 py-3 text-right" :class="e.amount < 0 ? 'text-text-secondary' : 'text-text-primary'">
                {{ formatMinor(e.amount, e.currency) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="next" class="mt-4 flex justify-center">
        <button class="btn-secondary" :disabled="more" @click="load(next)">{{ more ? 'Loading…' : 'Load more' }}</button>
      </div>
    </template>
  </template>
</template>
