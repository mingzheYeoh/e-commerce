<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import StatCard from '../components/StatCard.vue'
import SalesChart from '../components/SalesChart.vue'
import { merchantOverview, merchantBalance, merchantQueue, isError, type Balance, type Overview, type Queue } from '../api'
import { formatAmounts, formatMinor, groupByCurrency, seriesByCurrency } from '../money'

const data = ref<Overview | null>(null)
// The action cards are a second read; if it fails the overview still shows, without them.
const queue = ref<Queue | null>(null)
const error = ref<string | null>(null)
/** Settlement per currency; empty until anything has sold. A failed read hides the section, not the page. */
const balances = ref<Balance[]>([])

onMounted(async () => {
  const [{ body }, money, q] = await Promise.all([merchantOverview(), merchantBalance(), merchantQueue()])
  if (isError(body)) error.value = body.error
  else if ('revenue' in body) data.value = body
  else error.value = 'Something went wrong. Reload and try again.'
  if ('balances' in money.body) balances.value = money.body.balances
  if ('toShip' in q.body) queue.value = q.body
})

const TILE = 'block rounded-card transition-colors hover:[&>div]:border-border-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent'

const series = computed(() => (data.value ? seriesByCurrency(data.value.trend) : []))
const top = computed(() => (data.value ? groupByCurrency(data.value.top) : []))
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
/** The order count, and the gross before refunds when refunds made the two differ. */
const sub = (window: 'today' | 'week' | 'month') => {
  const d = data.value!
  const gross = formatAmounts(d.gross[window])
  return gross === formatAmounts(d.revenue[window])
    ? plural(d.orders[window], 'order')
    : `${plural(d.orders[window], 'order')} · ${gross} gross`
}
</script>

<template>
  <h1 class="mb-6 font-display text-xl font-bold text-text-primary">Overview</h1>

  <p v-if="error" class="text-sm text-accent-amber">{{ error }}</p>
  <p v-else-if="!data" class="text-text-secondary">Loading…</p>
  <div v-else class="flex flex-col gap-6">
    <p class="-mt-4 text-xs text-text-muted">
      Net sales: your lines on paid orders less what was refunded on them, excluding shipping and tax.
      Gross is before refunds. Days are UTC.
    </p>

    <section v-if="queue && (queue.toShip || queue.lowStock || queue.outOfStock)" class="grid grid-cols-1 gap-3 xs:grid-cols-2" aria-label="Needs doing">
      <router-link v-if="queue.toShip" to="/orders?status=pending" :class="TILE">
        <div class="card border-accent-amber/40 p-4">
          <p class="label">Orders to ship</p>
          <p class="nums mt-1 font-display text-xl font-bold text-accent-amber">{{ queue.toShip }}</p>
          <p class="mt-1 text-xs text-text-secondary">Paid and waiting on you → ship them</p>
        </div>
      </router-link>
      <router-link v-if="queue.lowStock || queue.outOfStock" :to="`/inventory?filter=${queue.outOfStock ? 'out' : 'low'}`" :class="TILE">
        <div class="card border-accent-amber/40 p-4">
          <p class="label">Stock running out</p>
          <p class="nums mt-1 font-display text-xl font-bold text-accent-amber">
            {{ queue.outOfStock }} out · {{ queue.lowStock }} low
          </p>
          <p class="mt-1 text-xs text-text-secondary">Live products at {{ queue.lowStockAt }} or fewer → restock</p>
        </div>
      </router-link>
    </section>

    <section class="grid grid-cols-1 gap-3 xs:grid-cols-2 lg:grid-cols-4">
      <router-link to="/orders" :class="TILE">
        <StatCard label="Net today" :value="formatAmounts(data.revenue.today, 'No sales')" :sub="sub('today')" />
      </router-link>
      <router-link to="/reports" :class="TILE">
        <StatCard label="Net, last 7 days" :value="formatAmounts(data.revenue.week, 'No sales')" :sub="sub('week')" />
      </router-link>
      <router-link to="/reports" :class="TILE">
        <StatCard label="Net, last 30 days" :value="formatAmounts(data.revenue.month, 'No sales')" :sub="sub('month')" />
      </router-link>
      <router-link to="/inventory" :class="TILE">
        <StatCard
          label="Products"
          :value="`${data.products.published} live`"
          :sub="`${data.products.draft} draft · ${data.products.archived} archived`"
        />
      </router-link>
    </section>

    <section v-if="balances.length" class="card p-4 md:p-6">
      <h2 class="mb-1 flex items-baseline justify-between gap-3 text-sm font-semibold text-text-primary">
        Balance
        <router-link to="/finance" class="text-xs font-normal text-accent hover:text-accent-hover">Statement and payouts →</router-link>
      </h2>
      <p class="mb-4 text-xs text-text-muted">
        All time: net sales, less the platform's commission at the rate each sale was made at, less payouts.
        Payouts are simulated, like payment.
      </p>
      <ul class="flex flex-col divide-y divide-border-hairline">
        <li v-for="b in balances" :key="b.currency" class="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2.5 text-sm">
          <span class="label w-12">{{ b.currency }}</span>
          <span
            class="nums font-semibold"
            :class="b.owes ? 'text-accent-red' : 'text-text-primary'"
          >{{ formatMinor(b.owes ? -b.available : b.available, b.currency) }}</span>
          <span v-if="b.owes" class="rounded-full border border-accent-red/40 px-2 py-0.5 text-xs text-accent-red">
            You owe the platform
          </span>
          <span v-else class="text-xs text-text-secondary">available</span>
          <span class="nums text-xs text-text-muted">
            {{ formatMinor(b.gross, b.currency) }} gross · {{ formatMinor(b.refunds, b.currency) }} refunded ·
            {{ formatMinor(b.commission, b.currency) }} commission · {{ formatMinor(b.payouts, b.currency) }} paid out ·
            now {{ b.currentBps / 100 }}%
          </span>
        </li>
      </ul>
    </section>

    <section class="card p-4 md:p-6">
      <h2 class="mb-4 text-sm font-semibold text-text-primary">Daily net sales, last 30 days</h2>
      <p v-if="series.length === 0" class="text-sm text-text-secondary">No sales in the last 30 days.</p>
      <div v-else class="flex flex-col gap-8">
        <SalesChart v-for="s in series" :key="s.currency" :days="s.days" :currency="s.currency" />
      </div>
    </section>

    <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <section class="card p-4 md:p-6">
        <h2 class="mb-4 text-sm font-semibold text-text-primary">Top products by net sales, last 30 days</h2>
        <p v-if="data.top.length === 0" class="text-sm text-text-secondary">Nothing sold yet.</p>
        <div v-else class="flex flex-col gap-5">
          <!-- The worker ranks within each currency; so does the numbering here. -->
          <div v-for="g in top" :key="g.currency">
            <h3 v-if="top.length > 1" class="label mb-1">{{ g.currency }}</h3>
            <ol class="flex flex-col divide-y divide-border-hairline">
              <li v-for="(t, i) in g.rows" :key="t.productId" class="flex items-center gap-3 py-2.5">
                <span class="nums w-5 text-xs text-text-muted">{{ i + 1 }}</span>
                <router-link :to="`/products/${t.productId}`" class="min-w-0 flex-1 truncate text-sm text-text-primary hover:text-accent">
                  {{ t.title }}
                </router-link>
                <span class="nums text-xs text-text-secondary">{{ t.qty }} sold</span>
                <span class="nums text-sm text-text-primary">{{ formatMinor(t.minor, t.currency) }}</span>
              </li>
            </ol>
          </div>
        </div>
      </section>

      <section class="card p-4 md:p-6">
        <h2 class="mb-4 text-sm font-semibold text-text-primary">Low stock</h2>
        <p v-if="data.lowStock.length === 0" class="text-sm text-text-secondary">Every live product has more than 5 in stock.</p>
        <ul v-else class="flex flex-col divide-y divide-border-hairline">
          <li v-for="p in data.lowStock" :key="p.id" class="flex items-center gap-3 py-2.5">
            <router-link :to="`/products/${p.id}`" class="min-w-0 flex-1 truncate text-sm text-text-primary hover:text-accent">
              {{ p.title }}
            </router-link>
            <span class="nums text-sm" :class="p.stockCount === 0 ? 'text-accent-amber' : 'text-text-secondary'">
              {{ p.stockCount === 0 ? 'Sold out' : `${p.stockCount} left` }}
            </span>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>
