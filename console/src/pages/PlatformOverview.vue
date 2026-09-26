<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import StatCard from '../components/StatCard.vue'
import SalesChart from '../components/SalesChart.vue'
import { platformOverview, isError, type Attention, type MerchantSummary, type PlatformOverview } from '../api'
import { formatAmounts, formatMinor, groupByCurrency, seriesByCurrency } from '../money'
import { addDays } from '../dates'

const overview = ref<PlatformOverview | null>(null)
const merchants = ref<MerchantSummary[]>([])
const attention = ref<Attention | null>(null)
const error = ref<string | null>(null)

onMounted(async () => {
  const { body } = await platformOverview()
  if (isError(body)) error.value = body.error
  else if ('overview' in body) {
    overview.value = body.overview
    merchants.value = body.merchants
    attention.value = body.attention
  } else error.value = 'Something went wrong. Reload and try again.'
})

/**
 * The overdue count is parts placed before the UTC day `overdueDays` ago began;
 * the order list's `to` is inclusive, so the day before that is the same cutoff.
 */
const overdueTo = computed(() => (attention.value ? addDays(new Date().toISOString().slice(0, 10), -attention.value.overdueDays - 1) : ''))

const count = (status: string) => merchants.value.filter((m) => m.status === status).length
const series = computed(() => (overview.value ? seriesByCurrency(overview.value.trend) : []))

/** Top ten per currency, each numbered on its own: sales in two currencies are not comparable numbers. */
const ranking = computed(() =>
  groupByCurrency(
    merchants.value
      .flatMap((m) => m.revenue.map((a) => ({ id: m.id, name: m.name, status: m.status, ...a })))
      .filter((r) => r.minor > 0)
      .sort((a, b) => a.currency.localeCompare(b.currency) || b.minor - a.minor),
  ).map((g) => ({ ...g, rows: g.rows.slice(0, 10) })),
)
</script>

<template>
  <h1 class="mb-6 font-display text-xl font-bold text-text-primary">Platform overview</h1>

  <p v-if="error" class="text-sm text-accent-amber">{{ error }}</p>
  <p v-else-if="!overview" class="text-text-secondary">Loading…</p>
  <div v-else class="flex flex-col gap-6">
    <p class="-mt-4 text-xs text-text-muted">Net sales: merchandise on paid orders less refunds, excluding shipping and tax. Gross is before refunds. Days are UTC.</p>

    <section class="grid grid-cols-1 gap-3 xs:grid-cols-2 lg:grid-cols-4">
      <StatCard label="Net, last 7 days" :value="formatAmounts(overview.revenue.week, 'No sales')" :sub="`${overview.orders.week} orders · ${formatAmounts(overview.gross.week)} gross`" />
      <StatCard label="Net, last 30 days" :value="formatAmounts(overview.revenue.month, 'No sales')" :sub="`${overview.orders.month} orders · ${formatAmounts(overview.gross.month)} gross`" />
      <router-link to="/platform/merchants" class="block rounded-card transition-colors hover:ring-1 hover:ring-border-strong">
        <StatCard label="Merchants" :value="`${count('active')} active`" :sub="`${count('suspended')} suspended`" />
      </router-link>
      <router-link :to="{ path: '/platform/orders', query: { status: 'pending' } }" class="block rounded-card transition-colors hover:ring-1 hover:ring-border-strong">
        <StatCard label="Parts to ship" :value="String(attention?.toShip ?? 0)" sub="Every merchant's unshipped parts" />
      </router-link>
    </section>

    <section v-if="attention" aria-labelledby="attention-h">
      <h2 id="attention-h" class="mb-3 text-sm font-semibold text-text-primary">Needs attention</h2>
      <div class="grid grid-cols-1 gap-3 xs:grid-cols-2 lg:grid-cols-4">
        <router-link to="/platform/applications" class="block rounded-card transition-colors hover:ring-1 hover:ring-border-strong">
          <StatCard label="Pending applications" :value="String(attention.pendingApplications)" sub="Review applications" />
        </router-link>
        <router-link
          :to="{ path: '/platform/orders', query: { status: 'pending', to: overdueTo } }"
          class="block rounded-card transition-colors hover:ring-1 hover:ring-border-strong"
        >
          <StatCard label="Overdue parts" :value="String(attention.overdue)" :sub="`To ship, placed on or before ${overdueTo}`" />
        </router-link>
        <div class="card p-4">
          <p class="label">Merchants owing the platform</p>
          <p class="nums mt-1 font-display text-xl font-bold text-text-primary">{{ attention.owingMerchants }}</p>
          <ul class="mt-1 flex flex-col gap-0.5 text-xs">
            <li v-for="o in attention.owing.slice(0, 5)" :key="`${o.merchantId}-${o.currency}`">
              <router-link :to="`/platform/merchants/${o.merchantId}`" class="text-text-secondary hover:text-accent">
                {{ o.name }} · <span class="nums text-accent-amber">{{ formatMinor(-o.available, o.currency) }}</span>
              </router-link>
            </li>
          </ul>
        </div>
        <div class="card p-4">
          <p class="label">Merchants low on stock</p>
          <p class="nums mt-1 font-display text-xl font-bold text-text-primary">{{ attention.lowStock.length }}</p>
          <ul class="mt-1 flex flex-col gap-0.5 text-xs">
            <li v-for="l in attention.lowStock.slice(0, 5)" :key="l.merchantId">
              <router-link :to="`/platform/merchants/${l.merchantId}`" class="text-text-secondary hover:text-accent">
                {{ l.name }} · {{ l.products }} at {{ attention.lowStockAt }} or fewer
              </router-link>
            </li>
          </ul>
        </div>
      </div>
    </section>

    <section class="card p-4 md:p-6">
      <h2 class="mb-4 text-sm font-semibold text-text-primary">Daily net sales, last 30 days</h2>
      <p v-if="series.length === 0" class="text-sm text-text-secondary">No sales in the last 30 days.</p>
      <div v-else class="flex flex-col gap-8">
        <SalesChart v-for="s in series" :key="s.currency" :days="s.days" :currency="s.currency" />
      </div>
    </section>

    <section class="card p-4 md:p-6">
      <h2 class="mb-4 text-sm font-semibold text-text-primary">Merchants by net sales, last 30 days</h2>
      <p v-if="ranking.length === 0" class="text-sm text-text-secondary">No merchant has sold anything in the last 30 days.</p>
      <div v-else class="flex flex-col gap-5">
        <div v-for="g in ranking" :key="g.currency">
          <h3 v-if="ranking.length > 1" class="label mb-1">{{ g.currency }}</h3>
          <ol class="flex flex-col divide-y divide-border-hairline">
            <li v-for="(r, i) in g.rows" :key="r.id" class="flex items-center gap-3 py-2.5">
              <span class="nums w-5 text-xs text-text-muted">{{ i + 1 }}</span>
              <span class="min-w-0 flex-1 truncate text-sm text-text-primary">{{ r.name }}</span>
              <span v-if="r.status !== 'active'" class="text-xs capitalize text-accent-amber">{{ r.status }}</span>
              <span class="nums text-sm text-text-primary">{{ formatMinor(r.minor, r.currency) }}</span>
            </li>
          </ol>
        </div>
      </div>
    </section>
  </div>
</template>
