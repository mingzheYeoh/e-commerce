<script setup lang="ts">
// The platform's sales for a range beside the same number of days before it,
// per currency. Every sum is the worker's, and the take is the balance's own
// commission rule; this page divides for ratios and formats, once.
// The range lives in the URL (?preset=30 or ?from=&to=).
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Download } from 'lucide-vue-next'
import StatCard from '../components/StatCard.vue'
import SalesChart from '../components/SalesChart.vue'
import { platformReport, isError, type PlatformReport, type ReportTotals } from '../api'
import { change, formatMinor, minorToDecimal } from '../money'
import { PRESETS, buckets, presetRange, type Preset } from '../dates'
import { CATEGORIES } from '../categories'
import { rate, shipTime } from '../orders'
import { download } from '../csv'

const route = useRoute()
const router = useRouter()

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const selected = computed<{ preset: Preset | 'custom'; from: string; to: string }>(() => {
  const [from, to] = [str(route.query.from), str(route.query.to)]
  if (from && to) return { preset: 'custom', from, to }
  const preset = (PRESETS.find((p) => p.id === route.query.preset)?.id ?? '30') as Preset
  return { preset, ...presetRange(preset) }
})
const custom = ref(false)
const form = ref({ from: '', to: '' })

const report = ref<PlatformReport | null>(null)
const error = ref<string | null>(null)
const loading = ref(false)

async function load() {
  loading.value = true
  error.value = null
  const { from, to } = selected.value
  form.value = { from, to }
  const { body } = await platformReport(from, to)
  if (isError(body)) error.value = body.error
  else if ('totals' in body) report.value = body
  else error.value = 'Something went wrong. Reload and try again.'
  loading.value = false
}
watch(selected, () => route.path === '/platform/reports' && load(), { immediate: true })

const pick = (preset: Preset) => {
  custom.value = false
  void router.replace({ query: { preset } })
}
const applyCustom = () => void router.replace({ query: { from: form.value.from, to: form.value.to } })

const EMPTY = (currency: string): ReportTotals => ({ currency, gross: 0, refunds: 0, net: 0, commission: 0, earnings: 0, orders: 0, units: 0 })
const NO_CHARGES = { orders: 0, goods: 0, shipping: 0, tax: 0, total: 0 }

const sections = computed(() => {
  const r = report.value
  if (!r) return []
  const currencies = [...new Set([...r.totals, ...r.previous.totals, ...r.charges].map((t) => t.currency))].sort()
  const axis = buckets(r.from, r.to, r.bucket === 'week' ? 7 : 1)
  return currencies.map((currency) => {
    const now = r.totals.find((t) => t.currency === currency) ?? EMPTY(currency)
    const before = r.previous.totals.find((t) => t.currency === currency) ?? EMPTY(currency)
    const charged = r.charges.find((c) => c.currency === currency && c.period === 'now') ?? NO_CHARGES
    const chargedBefore = r.charges.find((c) => c.currency === currency && c.period === 'before') ?? NO_CHARGES
    const categories = r.categories.filter((c) => c.currency === currency)
    const merchants = r.merchants.filter((m) => m.currency === currency)
    const top = [...merchants].sort((a, b) => b.gross - a.gross).slice(0, 10)
    return {
      currency,
      now,
      before,
      charged,
      chargedBefore,
      series: axis.map((day) => ({ day, minor: r.series.find((s) => s.start === day && s.currency === currency)?.gross ?? 0 })),
      categories,
      catMax: Math.max(1, ...categories.map((c) => c.gross)),
      top,
      topMax: Math.max(1, ...top.map((m) => m.gross)),
      products: r.products.filter((p) => p.currency === currency).slice(0, 20),
    }
  })
})

const signups = computed(() => {
  const r = report.value
  if (!r) return []
  return buckets(r.from, r.to, 7).map((day) => ({ day, minor: r.signups.find((s) => s.start === day)?.count ?? 0 }))
})

/** Per merchant: its sales rows (one per currency) beside its fulfilment. */
const leaderboard = computed(() => {
  const r = report.value
  if (!r) return []
  return r.merchants.map((m) => ({ ...m, health: r.health.find((h) => h.merchantId === m.merchantId) }))
})

const aov = (c: { orders: number; total: number }) => (c.orders ? Math.floor(c.total / c.orders) : 0)
const vs = (now: number, before: number) => {
  const c = change(now, before)
  return c ? `${c} vs previous` : before === now ? 'No change' : 'Nothing to compare'
}
const catLabel = (id: string) => CATEGORIES.find((c) => c.id === id)?.label ?? id

function kpis(s: (typeof sections.value)[number]) {
  const m = (v: number) => formatMinor(v, s.currency)
  const st = s.charged.shipping + s.charged.tax
  const stBefore = s.chargedBefore.shipping + s.chargedBefore.tax
  return [
    { label: 'GMV (goods)', value: m(s.now.gross), sub: vs(s.now.gross, s.before.gross) },
    { label: 'Shipping + tax collected', value: m(st), sub: vs(st, stBefore) },
    { label: 'Refunds', value: m(s.now.refunds), sub: vs(s.now.refunds, s.before.refunds) },
    { label: 'Net sales', value: m(s.now.net), sub: vs(s.now.net, s.before.net) },
    { label: 'Platform take', value: m(s.now.commission), sub: vs(s.now.commission, s.before.commission) },
    { label: 'Merchant earnings', value: m(s.now.earnings), sub: vs(s.now.earnings, s.before.earnings) },
    { label: 'Orders', value: String(s.charged.orders), sub: vs(s.charged.orders, s.chargedBefore.orders) },
    { label: 'Average order (charged)', value: m(aov(s.charged)), sub: vs(aov(s.charged), aov(s.chargedBefore)) },
    { label: 'Refund rate', value: rate(s.now.refunds, s.now.gross), sub: `${rate(s.before.refunds, s.before.gross)} previous` },
  ]
}

function exportMerchants() {
  const r = report.value!
  download(`merchants-${r.from}-to-${r.to}.csv`, [
    ['Merchant', 'Merchant id', 'Currency', 'Orders', 'Units', 'Gross', 'Refunds', 'Net', 'Commission', 'Refund rate', 'Parts', 'Cancelled', 'Avg ship (hours)'],
    ...leaderboard.value.map((m) => [
      m.name,
      m.merchantId,
      m.currency,
      m.orders,
      m.units,
      minorToDecimal(m.gross),
      minorToDecimal(m.refunds),
      minorToDecimal(m.net),
      minorToDecimal(m.commission),
      rate(m.refunds, m.gross),
      m.health?.parts ?? 0,
      m.health?.cancelled ?? 0,
      m.health?.avgShipSeconds == null ? null : (m.health.avgShipSeconds / 3600).toFixed(1),
    ]),
  ])
}

function exportProducts() {
  const r = report.value!
  download(`platform-products-${r.from}-to-${r.to}.csv`, [
    ['Product', 'Product id', 'Currency', 'Units sold', 'Gross', 'Net'],
    ...r.products.map((p) => [p.title, p.productId, p.currency, p.units, minorToDecimal(p.gross), minorToDecimal(p.net)]),
  ])
}
</script>

<template>
  <h1 class="mb-6 font-display text-xl font-bold text-text-primary">Reports</h1>

  <div class="mb-6 flex flex-col gap-3">
    <div class="-mx-4 flex gap-1 overflow-x-auto px-4 md:mx-0 md:px-0" role="group" aria-label="Date range">
      <button
        v-for="p in PRESETS"
        :key="p.id"
        class="whitespace-nowrap rounded-full border px-3 py-1.5 text-sm transition-colors"
        :class="!custom && selected.preset === p.id ? 'border-accent bg-surface-2 text-text-primary' : 'border-border-hairline text-text-secondary hover:text-text-primary'"
        :aria-pressed="!custom && selected.preset === p.id"
        @click="pick(p.id)"
      >
        {{ p.label }}
      </button>
      <button
        class="whitespace-nowrap rounded-full border px-3 py-1.5 text-sm transition-colors"
        :class="custom || selected.preset === 'custom' ? 'border-accent bg-surface-2 text-text-primary' : 'border-border-hairline text-text-secondary hover:text-text-primary'"
        :aria-pressed="custom || selected.preset === 'custom'"
        @click="custom = true"
      >
        Custom
      </button>
    </div>
    <form v-if="custom || selected.preset === 'custom'" class="flex flex-wrap items-end gap-3" @submit.prevent="applyCustom">
      <div class="min-w-[9rem] flex-1 sm:flex-none">
        <label class="label mb-1 block" for="preport-from">From</label>
        <input id="preport-from" v-model="form.from" class="input" type="date" required />
      </div>
      <div class="min-w-[9rem] flex-1 sm:flex-none">
        <label class="label mb-1 block" for="preport-to">To</label>
        <input id="preport-to" v-model="form.to" class="input" type="date" required />
      </div>
      <button class="btn-primary" type="submit" :disabled="loading">Show</button>
    </form>
  </div>

  <p v-if="error" class="mb-4 text-sm text-accent-amber" role="alert">{{ error }}</p>
  <p v-if="loading && !report" class="text-text-secondary">Loading…</p>
  <template v-else-if="report">
    <p class="mb-6 text-xs text-text-muted">
      {{ report.from }} to {{ report.to }} (UTC), against {{ report.previous.from }} to {{ report.previous.to }}.
      GMV is goods on paid orders placed in the range, before refunds; refunds are those orders', whenever made. The take is each
      merchant's commission on its net, each line at the rate it was sold at. Orders, shipping, tax and the average order are per
      order, in the order's currency; an order in more than one currency counts under XXX.
    </p>
    <p v-if="sections.length === 0" class="card p-6 text-text-secondary">No sales in this range or the one before it.</p>

    <section v-for="s in sections" :key="s.currency" class="mb-10 flex flex-col gap-6" :aria-label="`${s.currency} sales`">
      <h2 v-if="sections.length > 1" class="font-display text-lg font-bold text-text-primary">{{ s.currency }}</h2>

      <div class="grid grid-cols-1 gap-3 xs:grid-cols-2 lg:grid-cols-3">
        <StatCard v-for="k in kpis(s)" :key="k.label" :label="k.label" :value="k.value" :sub="k.sub" />
      </div>

      <div v-if="s.now.gross || s.before.gross" class="card p-4 md:p-6">
        <h3 class="mb-4 text-sm font-semibold text-text-primary">GMV by {{ report.bucket }}</h3>
        <SalesChart :days="s.series" :currency="s.currency" :bucket="report.bucket" />
      </div>

      <div v-if="s.categories.length || s.top.length" class="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div class="card p-4 md:p-6">
          <h3 class="mb-4 text-sm font-semibold text-text-primary">GMV by category</h3>
          <ul class="flex flex-col gap-3">
            <li v-for="c in s.categories" :key="c.category">
              <div class="mb-1 flex items-baseline justify-between gap-3 text-sm">
                <span class="truncate text-text-primary">{{ catLabel(c.category) }}</span>
                <span class="nums whitespace-nowrap text-text-secondary">{{ formatMinor(c.gross, s.currency) }} · {{ c.units }} sold</span>
              </div>
              <svg viewBox="0 0 100 4" preserveAspectRatio="none" class="block h-2 w-full" aria-hidden="true">
                <rect x="0" y="0" width="100" height="4" rx="1" class="fill-surface-2" />
                <rect x="0" y="0" :width="Math.max((c.gross / s.catMax) * 100, c.gross ? 1 : 0)" height="4" rx="1" class="fill-accent" />
              </svg>
            </li>
          </ul>
        </div>
        <div class="card p-4 md:p-6">
          <h3 class="mb-4 text-sm font-semibold text-text-primary">GMV by merchant, top {{ s.top.length }}</h3>
          <ul class="flex flex-col gap-3">
            <li v-for="m in s.top" :key="m.merchantId">
              <div class="mb-1 flex items-baseline justify-between gap-3 text-sm">
                <router-link :to="`/platform/merchants/${m.merchantId}`" class="truncate text-text-primary hover:text-accent">{{ m.name }}</router-link>
                <span class="nums whitespace-nowrap text-text-secondary">{{ formatMinor(m.gross, s.currency) }}</span>
              </div>
              <svg viewBox="0 0 100 4" preserveAspectRatio="none" class="block h-2 w-full" aria-hidden="true">
                <rect x="0" y="0" width="100" height="4" rx="1" class="fill-surface-2" />
                <rect x="0" y="0" :width="Math.max((m.gross / s.topMax) * 100, m.gross ? 1 : 0)" height="4" rx="1" class="fill-accent" />
              </svg>
            </li>
          </ul>
        </div>
      </div>

      <div v-if="s.products.length" class="card overflow-x-auto">
        <h3 class="border-b border-border-hairline p-4 text-sm font-semibold text-text-primary">Top {{ s.products.length }} products by net sales</h3>
        <table class="w-full text-left text-sm">
          <thead class="border-b border-border-hairline">
            <tr class="label">
              <th class="px-4 py-3 font-medium">Product</th>
              <th class="px-4 py-3 text-right font-medium">Units</th>
              <th class="px-4 py-3 text-right font-medium">Gross</th>
              <th class="px-4 py-3 text-right font-medium">Net</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in s.products" :key="p.productId" class="border-b border-border-hairline last:border-0">
              <td class="whitespace-nowrap px-4 py-3 text-text-primary">{{ p.title }}</td>
              <td class="nums px-4 py-3 text-right text-text-secondary">{{ p.units }}</td>
              <td class="nums whitespace-nowrap px-4 py-3 text-right text-text-secondary">{{ formatMinor(p.gross, s.currency) }}</td>
              <td class="nums whitespace-nowrap px-4 py-3 text-right text-text-primary">{{ formatMinor(p.net, s.currency) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="card mb-6 p-4 md:p-6">
      <h2 class="mb-1 text-sm font-semibold text-text-primary">New customer accounts by week</h2>
      <p class="mb-4 text-xs text-text-secondary">
        Paid orders in the range: {{ report.buyers.accounts }} signed in, {{ report.buyers.guests }} as guests.
      </p>
      <SalesChart :days="signups" currency="Sign-ups" bucket="week" count />
    </section>

    <section v-if="leaderboard.length" class="card mb-6">
      <div class="flex flex-wrap items-center justify-between gap-3 border-b border-border-hairline p-4">
        <h2 class="text-sm font-semibold text-text-primary">Merchant leaderboard</h2>
        <button class="btn-ghost inline-flex items-center gap-2 px-3 py-2" @click="exportMerchants">
          <Download class="h-4 w-4" aria-hidden="true" />Export CSV
        </button>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="border-b border-border-hairline">
            <tr class="label">
              <th class="px-4 py-3 font-medium">Merchant</th>
              <th class="px-4 py-3 text-right font-medium">Net sales</th>
              <th class="px-4 py-3 text-right font-medium">Take</th>
              <th class="px-4 py-3 text-right font-medium">Orders</th>
              <th class="px-4 py-3 text-right font-medium">Refund rate</th>
              <th class="px-4 py-3 text-right font-medium">Avg ship</th>
              <th class="px-4 py-3 text-right font-medium">Cancelled</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in leaderboard" :key="`${m.merchantId}-${m.currency}`" class="nums whitespace-nowrap border-b border-border-hairline last:border-0">
              <td class="px-4 py-3">
                <router-link :to="`/platform/merchants/${m.merchantId}`" class="text-text-primary hover:text-accent">{{ m.name }}</router-link>
              </td>
              <td class="px-4 py-3 text-right text-text-primary">{{ formatMinor(m.net, m.currency) }}</td>
              <td class="px-4 py-3 text-right text-text-secondary">{{ formatMinor(m.commission, m.currency) }}</td>
              <td class="px-4 py-3 text-right text-text-secondary">{{ m.orders }}</td>
              <td class="px-4 py-3 text-right text-text-secondary">{{ rate(m.refunds, m.gross) }}</td>
              <td class="px-4 py-3 text-right text-text-secondary">{{ shipTime(m.health?.avgShipSeconds ?? null) }}</td>
              <td class="px-4 py-3 text-right text-text-secondary">{{ rate(m.health?.cancelled ?? 0, m.health?.parts ?? 0) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="p-4 text-xs text-text-muted">
        One row per merchant and currency. Ship time runs from the order being placed to the merchant marking it shipped; the
        cancellation rate is cancelled parts of the merchant's parts in the range.
      </p>
    </section>

    <section v-if="report.products.length" class="flex justify-end">
      <button class="btn-ghost inline-flex items-center gap-2 px-3 py-2" @click="exportProducts">
        <Download class="h-4 w-4" aria-hidden="true" />Every product sold, CSV
      </button>
    </section>
  </template>
</template>
