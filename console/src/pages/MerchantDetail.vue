<script setup lang="ts">
// One merchant, for the platform: who they are, how they sell and ship, what
// is owed, and the two money actions the platform takes on their behalf.
// Both writes are the worker's existing routes, each audited in the same
// batch as the change; a refusal (a payout over the balance) is shown as said.
import { computed, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import StatCard from '../components/StatCard.vue'
import SalesChart from '../components/SalesChart.vue'
import {
  merchantDetail,
  merchantSales,
  setCommission,
  recordPayout,
  isError,
  type Balance,
  type MerchantDetail,
  type SalesReport,
} from '../api'
import { change, formatBps, formatMinor, parsePriceToMinor } from '../money'
import { buckets, presetRange, type Preset } from '../dates'
import { placed, rate, shipTime } from '../orders'

const props = defineProps<{ id: string }>()
const m = ref<MerchantDetail | null>(null)
const sales = ref<SalesReport | null>(null)
const error = ref<string | null>(null)
const salesError = ref<string | null>(null)
const route = useRoute()
const router = useRouter()
const RANGES = ['7', '30', '90'] as const
/** The sales range lives in the URL (?range=7|30|90), 30 days by default. */
const range = computed<Preset>(() => (RANGES.find((r) => r === route.query.range) ?? '30') as Preset)
const pickRange = (r: Preset) => void router.replace({ query: r === '30' ? {} : { range: r } })

const actionError = ref<string | null>(null)
const notice = ref<string | null>(null)
const busy = ref(false)
const rateForm = ref('')
const payout = reactive<Record<string, { amount: string; reference: string }>>({})

/** Only the newest answer lands: a slow one for another merchant or range is dropped. */
let latest = 0
let latestSales = 0
async function load() {
  const mine = ++latest
  error.value = null
  const { status, body } = await merchantDetail(props.id)
  if (mine !== latest) return
  if (status === 404) error.value = 'No merchant with that id.'
  else if (isError(body)) error.value = body.error
  else if ('staff' in body) {
    m.value = body
    rateForm.value = (body.commissionBps / 100).toString()
    for (const b of body.balances) payout[b.currency] ??= { amount: '', reference: '' }
  } else error.value = 'Something went wrong. Reload and try again.'
}

async function loadSales() {
  const mine = ++latestSales
  salesError.value = null
  const { from, to } = presetRange(range.value)
  const { body } = await merchantSales(props.id, from, to)
  if (mine !== latestSales) return
  if (isError(body)) salesError.value = body.error
  else if ('totals' in body) sales.value = body
  else salesError.value = 'Something went wrong. Reload and try again.'
}

watch(() => props.id, load, { immediate: true })
watch([() => props.id, range], () => route.path.startsWith('/platform/merchants/') && loadSales(), { immediate: true })

const trends = computed(() => {
  const r = sales.value
  if (!r) return []
  const axis = buckets(r.from, r.to, r.bucket === 'week' ? 7 : 1)
  return [...new Set([...r.totals, ...r.previous.totals].map((t) => t.currency))].sort().map((currency) => {
    const now = r.totals.find((t) => t.currency === currency)
    const before = r.previous.totals.find((t) => t.currency === currency)
    const vs = (a = 0, b = 0) => change(a, b) ?? (a === b ? 'No change' : 'Nothing to compare')
    return {
      currency,
      cards: [
        { label: 'Net sales', value: formatMinor(now?.net ?? 0, currency), sub: `${vs(now?.net, before?.net)} vs previous` },
        { label: 'Platform take', value: formatMinor(now?.commission ?? 0, currency), sub: `${vs(now?.commission, before?.commission)} vs previous` },
        { label: 'Orders', value: String(now?.orders ?? 0), sub: `${vs(now?.orders, before?.orders)} vs previous` },
        { label: 'Refund rate', value: rate(now?.refunds ?? 0, now?.gross ?? 0), sub: `${rate(before?.refunds ?? 0, before?.gross ?? 0)} previous` },
      ],
      series: axis.map((day) => ({ day, minor: r.series.find((s) => s.start === day && s.currency === currency)?.net ?? 0 })),
    }
  })
})

async function run(fn: () => Promise<{ body: object }>, done: string) {
  busy.value = true
  actionError.value = null
  notice.value = null
  try {
    const { body } = await fn()
    if (isError(body)) actionError.value = body.error
    else {
      notice.value = done
      await load()
    }
  } catch {
    actionError.value = 'Could not reach the console. Reload to see whether the change landed.'
  } finally {
    busy.value = false
  }
}

function saveRate() {
  // A percentage with up to two decimals is a whole number of basis points: 8.25% is 825.
  const bps = parsePriceToMinor(rateForm.value)
  if (bps === null || bps > 10_000) {
    actionError.value = 'The rate is a percentage from 0 to 100, such as 8 or 8.25.'
    return
  }
  if (!window.confirm(`Set ${m.value!.name}'s commission to ${formatBps(bps)}?\n\nIt prices sales from now on; every past sale keeps the rate it was sold at.`)) return
  void run(() => setCommission(props.id, bps), `Commission set to ${formatBps(bps)}.`)
}

function pay(b: Balance) {
  const form = payout[b.currency]
  const amountMinor = parsePriceToMinor(form.amount)
  if (amountMinor === null || amountMinor === 0) {
    actionError.value = 'The payout is an amount such as 120.50.'
    return
  }
  if (amountMinor > b.available) {
    actionError.value = `That is more than the ${formatMinor(Math.max(b.available, 0), b.currency)} available.`
    return
  }
  if (!form.reference.trim()) {
    actionError.value = 'Give the period or bank reference this payout covers.'
    return
  }
  if (!window.confirm(`Record a payout of ${formatMinor(amountMinor, b.currency)} to ${m.value!.name}, reference "${form.reference.trim()}"?\n\nThis cannot be undone.`)) return
  void run(async () => {
    const res = await recordPayout(props.id, { currency: b.currency, amountMinor, reference: form.reference.trim() })
    if (!isError(res.body)) payout[b.currency] = { amount: '', reference: '' }
    return res
  }, `Payout of ${formatMinor(amountMinor, b.currency)} recorded.`)
}

const BADGE: Record<string, string> = {
  active: 'border-accent-green/40 text-accent-green',
  suspended: 'border-accent-amber/40 text-accent-amber',
  pending: 'border-border-strong text-text-secondary',
}
</script>

<template>
  <router-link to="/platform/merchants" class="mb-4 inline-block text-sm text-text-secondary hover:text-text-primary">← Merchants</router-link>

  <p v-if="error" class="text-sm text-accent-amber" role="alert">{{ error }}</p>
  <p v-else-if="!m" class="text-text-secondary">Loading…</p>
  <div v-else class="flex flex-col gap-6">
    <header class="flex flex-wrap items-center gap-x-4 gap-y-2">
      <h1 class="font-display text-xl font-bold text-text-primary">{{ m.name }}</h1>
      <span class="rounded-full border px-2 py-0.5 text-xs capitalize" :class="BADGE[m.status]">{{ m.status }}</span>
      <span class="code">{{ m.slug }} · joined {{ m.createdAt.slice(0, 10) }} · settles in {{ m.settlementCurrency }}</span>
      <div class="ml-auto flex gap-2">
        <router-link :to="{ path: '/platform/orders', query: { merchant: m.id } }" class="btn-ghost px-3 py-1.5 text-xs">Orders</router-link>
        <router-link :to="{ path: '/platform/payments', query: { merchant: m.id } }" class="btn-ghost px-3 py-1.5 text-xs">Payments</router-link>
        <router-link :to="{ path: '/platform/audit', query: { merchant: m.id } }" class="btn-ghost px-3 py-1.5 text-xs">Audit log</router-link>
      </div>
    </header>

    <p v-if="actionError" class="text-sm text-accent-amber" role="alert">{{ actionError }}</p>
    <p v-if="notice" class="text-sm text-accent-green" role="status">{{ notice }}</p>

    <section aria-labelledby="sales-h">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 id="sales-h" class="text-sm font-semibold text-text-primary">Sales</h2>
        <div class="flex gap-1" role="group" aria-label="Date range">
          <button
            v-for="p in RANGES"
            :key="p"
            class="rounded-full border px-3 py-1 text-xs"
            :class="range === p ? 'border-accent bg-surface-2 text-text-primary' : 'border-border-hairline text-text-secondary'"
            :aria-pressed="range === p"
            @click="pickRange(p)"
          >
            {{ p }} days
          </button>
        </div>
      </div>
      <p v-if="salesError" class="text-sm text-accent-amber" role="alert">{{ salesError }}</p>
      <p v-else-if="!sales" class="text-text-secondary">Loading…</p>
      <p v-else-if="trends.length === 0" class="card p-6 text-text-secondary">No sales in this range or the one before it.</p>
      <div v-for="t in trends" :key="t.currency" class="mb-4 flex flex-col gap-3">
        <div class="grid grid-cols-1 gap-3 xs:grid-cols-2 lg:grid-cols-4">
          <StatCard v-for="k in t.cards" :key="k.label" :label="k.label" :value="k.value" :sub="k.sub" />
        </div>
        <div class="card p-4">
          <SalesChart :days="t.series" :currency="t.currency" :bucket="sales!.bucket" />
        </div>
      </div>
    </section>

    <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <section class="card p-4" aria-labelledby="health-h">
        <h2 id="health-h" class="mb-3 text-sm font-semibold text-text-primary">Fulfilment, all time</h2>
        <dl class="nums grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <dt class="text-text-secondary">To ship</dt>
          <dd class="text-right text-text-primary">{{ m.health.toShip }}</dd>
          <dt class="text-text-secondary">Pending over {{ m.health.overdueDays }} days</dt>
          <dd class="text-right" :class="m.health.overdue ? 'text-accent-amber' : 'text-text-primary'">{{ m.health.overdue }}</dd>
          <dt class="text-text-secondary">Average time to ship</dt>
          <dd class="text-right text-text-primary">{{ shipTime(m.health.avgShipSeconds) }}</dd>
          <dt class="text-text-secondary">Cancelled</dt>
          <dd class="text-right text-text-primary">{{ rate(m.health.cancelled, m.health.parts) }} of {{ m.health.parts }}</dd>
          <template v-for="b in m.balances" :key="b.currency">
            <dt class="text-text-secondary">Refund rate, {{ b.currency }}</dt>
            <dd class="text-right text-text-primary">{{ rate(b.refunds, b.gross) }}</dd>
          </template>
        </dl>
      </section>

      <section class="card p-4" aria-labelledby="products-h">
        <h2 id="products-h" class="mb-3 text-sm font-semibold text-text-primary">Products</h2>
        <p class="nums mb-3 text-sm text-text-secondary">
          {{ m.products.published }} on sale · {{ m.products.draft }} draft · {{ m.products.archived }} archived ·
          <span :class="m.products.lowStock ? 'text-accent-amber' : ''">{{ m.products.lowStock }} low</span> ·
          <span :class="m.products.outOfStock ? 'text-accent-amber' : ''">{{ m.products.outOfStock }} out</span>
        </p>
        <ul v-if="m.low.length" class="flex flex-col divide-y divide-border-hairline">
          <li v-for="p in m.low" :key="p.id" class="flex items-center justify-between gap-3 py-1.5 text-sm">
            <span class="min-w-0 truncate text-text-primary">{{ p.title }}</span>
            <span class="nums text-accent-amber">{{ p.stockCount }} left</span>
          </li>
        </ul>
        <p v-else class="text-sm text-text-secondary">Nothing on sale at {{ m.lowStockAt }} or fewer.</p>
      </section>
    </div>

    <section aria-labelledby="money-h">
      <div class="mb-3 flex flex-wrap items-end justify-between gap-3">
        <h2 id="money-h" class="text-sm font-semibold text-text-primary">Balance</h2>
        <form class="flex items-end gap-2" @submit.prevent="saveRate">
          <div class="w-28">
            <label class="label mb-1 block" for="rate">Commission %</label>
            <input id="rate" v-model="rateForm" class="input" inputmode="decimal" required />
          </div>
          <button class="btn-secondary" type="submit" :disabled="busy">Set rate</button>
        </form>
      </div>
      <p class="mb-3 text-xs text-text-secondary">Now {{ formatBps(m.commissionBps) }} of net sales, charged on sales from now on.</p>
      <p v-if="m.balances.length === 0" class="card p-6 text-text-secondary">No sales yet, so nothing is owed.</p>
      <div v-else class="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div v-for="b in m.balances" :key="b.currency" class="card p-4">
          <div class="mb-3 flex items-baseline justify-between gap-3">
            <span class="label">{{ b.owes ? 'Owes the platform' : 'Available' }}, {{ b.currency }}</span>
            <span class="nums font-display text-xl font-bold" :class="b.owes ? 'text-accent-amber' : 'text-text-primary'">
              {{ formatMinor(b.owes ? -b.available : b.available, b.currency) }}
            </span>
          </div>
          <dl class="nums mb-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <dt class="text-text-secondary">Gross</dt>
            <dd class="text-right text-text-primary">{{ formatMinor(b.gross, b.currency) }}</dd>
            <dt class="text-text-secondary">Refunds</dt>
            <dd class="text-right text-text-primary">−{{ formatMinor(b.refunds, b.currency) }}</dd>
            <dt class="text-text-secondary">Commission</dt>
            <dd class="text-right text-text-primary">−{{ formatMinor(b.commission, b.currency) }}</dd>
            <dt class="text-text-secondary">Paid out</dt>
            <dd class="text-right text-text-primary">−{{ formatMinor(b.payouts, b.currency) }}</dd>
          </dl>
          <form v-if="b.available > 0 && payout[b.currency]" class="flex flex-wrap items-end gap-2" @submit.prevent="pay(b)">
            <div class="w-28">
              <label class="label mb-1 block" :for="`pay-${b.currency}`">Pay out</label>
              <input :id="`pay-${b.currency}`" v-model="payout[b.currency].amount" class="input" inputmode="decimal" required />
            </div>
            <div class="min-w-[8rem] flex-1">
              <label class="label mb-1 block" :for="`ref-${b.currency}`">Reference</label>
              <input :id="`ref-${b.currency}`" v-model="payout[b.currency].reference" class="input" maxlength="120" required />
            </div>
            <button class="btn-secondary" type="submit" :disabled="busy">Record</button>
          </form>
        </div>
      </div>
    </section>

    <section class="card" aria-labelledby="staff-h">
      <h2 id="staff-h" class="border-b border-border-hairline p-4 text-sm font-semibold text-text-primary">Staff</h2>
      <ul class="divide-y divide-border-hairline">
        <li v-for="s in m.staff" :key="s.id" class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-2.5 text-sm">
          <span class="min-w-0 break-words text-text-primary">{{ s.email }} <span class="text-xs capitalize text-text-secondary">· {{ s.role }}</span></span>
          <span class="text-xs" :class="s.totpEnrolled ? 'text-accent-green' : 'text-accent-amber'">
            {{ s.totpEnrolled ? 'Authenticator enrolled' : 'Not enrolled yet' }}
          </span>
          <span class="nums w-full text-xs text-text-muted">since {{ placed(s.createdAt) }} UTC</span>
        </li>
      </ul>
    </section>
  </div>
</template>
