<script setup lang="ts">
// Sales for a range, per currency, beside the same number of days before it.
// Every figure is summed by the worker; this page only divides for a ratio
// and formats. Currencies are never added together, so each gets its own
// section.
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Download } from 'lucide-vue-next'
import StatCard from '../components/StatCard.vue'
import SalesChart from '../components/SalesChart.vue'
import { salesReport, isError, type ReportTotals, type SalesReport } from '../api'
import { change, formatMinor, minorToDecimal } from '../money'
import { PRESETS, buckets, presetRange, type Preset } from '../dates'
import { CATEGORIES } from '../categories'
import { download } from '../csv'

const route = useRoute()
const router = useRouter()

const preset = ref<Preset | 'custom'>('30')
const from = ref('')
const to = ref('')
const report = ref<SalesReport | null>(null)
const error = ref<string | null>(null)
const loading = ref(false)

/**
 * Only the newest request may land. A preset clicked while another is loading
 * would otherwise be overwritten by the older answer arriving second.
 */
let latest = 0
async function load() {
  const mine = ++latest
  loading.value = true
  error.value = null
  const { body } = await salesReport(from.value, to.value)
  if (mine !== latest) return
  if (isError(body)) error.value = body.error
  else if ('totals' in body) report.value = body
  else error.value = 'Something went wrong. Reload and try again.'
  loading.value = false
}

/*
 * The range lives in the URL (?range=7|30|90|month|last-month, or
 * ?range=custom&from=&to=), so a report can be reloaded, shared or returned to
 * with Back. The URL is read here and nowhere else; the buttons only write it.
 */
const PRESET_IDS = new Set<string>(PRESETS.map((p) => p.id))
watch(
  () => route.query,
  (q) => {
    if (route.path !== '/reports') return
    const range = typeof q.range === 'string' ? q.range : '30'
    if (range === 'custom' && typeof q.from === 'string' && typeof q.to === 'string') {
      preset.value = 'custom'
      ;[from.value, to.value] = [q.from, q.to]
    } else {
      preset.value = PRESET_IDS.has(range) ? (range as Preset) : '30'
      ;({ from: from.value, to: to.value } = presetRange(preset.value))
    }
    void load()
  },
  { immediate: true },
)

const pick = (p: Preset) => void router.replace({ query: { range: p } })
const custom = () => void router.replace({ query: { range: 'custom', from: from.value, to: to.value } })

const EMPTY = (currency: string): ReportTotals => ({ currency, gross: 0, refunds: 0, net: 0, commission: 0, earnings: 0, orders: 0, units: 0 })

/** One section per currency sold in either period, so a currency that stopped selling still shows its drop. */
const sections = computed(() => {
  const r = report.value
  if (!r) return []
  const currencies = [...new Set([...r.totals, ...r.previous.totals].map((t) => t.currency))].sort()
  const size = r.bucket === 'week' ? 7 : 1
  const axis = buckets(r.from, r.to, size)
  return currencies.map((currency) => {
    const now = r.totals.find((t) => t.currency === currency) ?? EMPTY(currency)
    const before = r.previous.totals.find((t) => t.currency === currency) ?? EMPTY(currency)
    const products = r.products.filter((p) => p.currency === currency)
    const categories = r.categories.filter((c) => c.currency === currency)
    return {
      currency,
      now,
      before,
      series: axis.map((day) => ({ day, minor: r.series.find((s) => s.start === day && s.currency === currency)?.net ?? 0 })),
      categories,
      catMax: Math.max(1, ...categories.map((c) => c.net)),
      top: products.slice(0, 10),
      // The weakest sellers outside the top ten, weakest first: none overlap it, so 12 products give 2.
      bottom: products.slice(Math.max(10, products.length - 5)).reverse(),
      products,
    }
  })
})

const aov = (t: ReportTotals) => (t.orders ? Math.round(t.net / t.orders) : 0)
const refundRate = (t: ReportTotals) => (t.gross ? t.refunds / t.gross : 0)
const pct = (x: number) => `${(x * 100).toFixed(1)}%`
const vs = (now: number, before: number) => {
  const c = change(now, before)
  return c ? `${c} vs previous` : before === now ? 'No change' : 'Nothing to compare'
}
const catLabel = (id: string) => CATEGORIES.find((c) => c.id === id)?.label ?? id

function kpis(s: (typeof sections.value)[number]) {
  const m = (v: number) => formatMinor(v, s.currency)
  return [
    { label: 'Gross sales', value: m(s.now.gross), sub: vs(s.now.gross, s.before.gross) },
    { label: 'Refunds', value: m(s.now.refunds), sub: vs(s.now.refunds, s.before.refunds) },
    { label: 'Net sales', value: m(s.now.net), sub: vs(s.now.net, s.before.net) },
    { label: 'Commission', value: m(s.now.commission), sub: vs(s.now.commission, s.before.commission) },
    { label: 'Your earnings', value: m(s.now.earnings), sub: vs(s.now.earnings, s.before.earnings) },
    { label: 'Orders', value: String(s.now.orders), sub: vs(s.now.orders, s.before.orders) },
    { label: 'Units sold', value: String(s.now.units), sub: vs(s.now.units, s.before.units) },
    { label: 'Average order', value: m(aov(s.now)), sub: vs(aov(s.now), aov(s.before)) },
    { label: 'Refund rate', value: pct(refundRate(s.now)), sub: `${pct(refundRate(s.before))} previous` },
  ]
}

function exportProducts() {
  const r = report.value!
  download(`products-${r.from}-to-${r.to}.csv`, [
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
        :class="preset === p.id ? 'border-accent bg-surface-2 text-text-primary' : 'border-border-hairline text-text-secondary hover:text-text-primary'"
        :aria-pressed="preset === p.id"
        @click="pick(p.id)"
      >
        {{ p.label }}
      </button>
      <button
        class="whitespace-nowrap rounded-full border px-3 py-1.5 text-sm transition-colors"
        :class="preset === 'custom' ? 'border-accent bg-surface-2 text-text-primary' : 'border-border-hairline text-text-secondary hover:text-text-primary'"
        :aria-pressed="preset === 'custom'"
        @click="preset = 'custom'"
      >
        Custom
      </button>
    </div>
    <form v-if="preset === 'custom'" class="flex flex-wrap items-end gap-3" @submit.prevent="custom">
      <div class="min-w-[9rem] flex-1 sm:flex-none">
        <label class="label mb-1 block" for="report-from">From</label>
        <input id="report-from" v-model="from" class="input" type="date" required />
      </div>
      <div class="min-w-[9rem] flex-1 sm:flex-none">
        <label class="label mb-1 block" for="report-to">To</label>
        <input id="report-to" v-model="to" class="input" type="date" required />
      </div>
      <button class="btn-primary" type="submit" :disabled="loading">Show</button>
    </form>
  </div>

  <p v-if="error" class="mb-4 text-sm text-accent-amber" role="alert">{{ error }}</p>
  <p v-if="loading && !report" class="text-text-secondary">Loading…</p>
  <div v-else-if="report" :aria-busy="loading" class="transition-opacity" :class="loading ? 'opacity-50' : ''">
    <p v-if="loading" class="mb-4 text-sm text-text-secondary" role="status">Updating…</p>
    <p class="mb-2 text-xs text-text-muted">
      {{ report.from }} to {{ report.to }} (UTC), against {{ report.previous.from }} to {{ report.previous.to }}.
      Sales are your lines on paid orders placed in the range; refunds are those orders' refunds, whenever made
      (the Finance statement dates a refund on the day it was made instead).
    </p>
    <ul class="mb-6 list-disc pl-5 text-xs text-text-muted">
      <li>Net is gross less refunds. Commission is charged on each sale at the rate it was sold at; earnings are net less commission.</li>
      <li>Orders are orders with a line of yours, cancelled ones included. Average order is net ÷ orders.</li>
      <li>Units sold are counted before refunds (Inventory's 30-day figure is after them). Refund rate is refunds ÷ gross.</li>
    </ul>
    <p v-if="sections.length === 0" class="card p-6 text-text-secondary">No sales in this range or the one before it.</p>

    <section v-for="s in sections" :key="s.currency" class="mb-10 flex flex-col gap-6" :aria-label="`${s.currency} sales`">
      <h2 v-if="sections.length > 1" class="font-display text-lg font-bold text-text-primary">{{ s.currency }}</h2>

      <div class="grid grid-cols-1 gap-3 xs:grid-cols-2 lg:grid-cols-3">
        <StatCard v-for="k in kpis(s)" :key="k.label" :label="k.label" :value="k.value" :sub="k.sub" />
      </div>

      <div class="card p-4 md:p-6">
        <h3 class="mb-4 text-sm font-semibold text-text-primary">Net sales by {{ report.bucket }}</h3>
        <SalesChart :days="s.series" :currency="s.currency" :bucket="report.bucket" />
      </div>

      <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div class="card p-4 md:p-6">
          <h3 class="mb-4 text-sm font-semibold text-text-primary">Net sales by category</h3>
          <p v-if="!s.categories.length" class="text-sm text-text-secondary">Nothing sold in this range.</p>
          <ul v-else class="flex flex-col gap-3">
            <li v-for="c in s.categories" :key="c.category">
              <div class="mb-1 flex items-baseline justify-between gap-3 text-sm">
                <span class="truncate text-text-primary">{{ catLabel(c.category) }}</span>
                <span class="nums whitespace-nowrap text-text-secondary">{{ formatMinor(c.net, s.currency) }} · {{ c.units }} sold</span>
              </div>
              <svg viewBox="0 0 100 4" preserveAspectRatio="none" class="block h-2 w-full" aria-hidden="true">
                <rect x="0" y="0" width="100" height="4" rx="1" class="fill-surface-2" />
                <rect x="0" y="0" :width="Math.max((c.net / s.catMax) * 100, c.net ? 1 : 0)" height="4" rx="1" class="fill-accent" />
              </svg>
            </li>
          </ul>
        </div>

        <div class="card p-4 md:p-6">
          <h3 class="mb-4 text-sm font-semibold text-text-primary">Top {{ Math.min(10, s.top.length) || '' }} products by net sales</h3>
          <p v-if="!s.top.length" class="text-sm text-text-secondary">Nothing sold in this range.</p>
          <ol v-else class="flex flex-col divide-y divide-border-hairline">
            <li v-for="(p, i) in s.top" :key="p.productId" class="flex items-center gap-3 py-2">
              <span class="nums w-5 text-xs text-text-muted">{{ i + 1 }}</span>
              <router-link :to="`/products/${p.productId}`" class="min-w-0 flex-1 truncate text-sm text-text-primary hover:text-accent">{{ p.title }}</router-link>
              <span class="nums text-xs text-text-secondary">{{ p.units }} sold</span>
              <span class="nums text-sm text-text-primary">{{ formatMinor(p.net, s.currency) }}</span>
            </li>
          </ol>
          <template v-if="s.bottom.length">
            <h3 class="mb-2 mt-6 text-sm font-semibold text-text-primary">Lowest {{ s.bottom.length }} of the rest</h3>
            <ul class="flex flex-col divide-y divide-border-hairline">
              <li v-for="p in s.bottom" :key="p.productId" class="flex items-center gap-3 py-2">
                <router-link :to="`/products/${p.productId}`" class="min-w-0 flex-1 truncate text-sm text-text-primary hover:text-accent">{{ p.title }}</router-link>
                <span class="nums text-xs text-text-secondary">{{ p.units }} sold</span>
                <span class="nums text-sm text-text-primary">{{ formatMinor(p.net, s.currency) }}</span>
              </li>
            </ul>
          </template>
        </div>
      </div>
    </section>

    <section v-if="report.products.length" class="card">
      <div class="flex flex-wrap items-center justify-between gap-3 border-b border-border-hairline p-4">
        <h2 class="text-sm font-semibold text-text-primary">Every product sold</h2>
        <button class="btn-ghost inline-flex items-center gap-2 px-3 py-2" @click="exportProducts">
          <Download class="h-4 w-4" aria-hidden="true" />Export CSV
        </button>
      </div>
      <div class="overflow-x-auto">
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
            <tr v-for="p in report.products" :key="`${p.currency}-${p.productId}`" class="border-b border-border-hairline last:border-0">
              <td class="px-4 py-3">
                <router-link :to="`/products/${p.productId}`" class="whitespace-nowrap text-text-primary hover:text-accent">{{ p.title }}</router-link>
              </td>
              <td class="nums px-4 py-3 text-right text-text-secondary">{{ p.units }}</td>
              <td class="nums whitespace-nowrap px-4 py-3 text-right text-text-secondary">{{ formatMinor(p.gross, p.currency) }}</td>
              <td class="nums whitespace-nowrap px-4 py-3 text-right text-text-primary">{{ formatMinor(p.net, p.currency) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
