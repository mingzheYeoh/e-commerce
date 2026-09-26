<script setup lang="ts">
// Every order on the platform, whoever sold into it. The same list as a
// merchant's Orders page, with a merchant filter: the filters live in the URL,
// so an overview card can link straight to a filtered view. Status filters on
// any part, or on the chosen merchant's part when one is picked.
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Download } from 'lucide-vue-next'
import {
  platformOrders,
  merchantNames,
  isError,
  type FulfilmentStatus,
  type MerchantName,
  type OrderFilter,
  type PlatformOrderSummary,
} from '../api'
import { formatAmounts, minorToDecimal } from '../money'
import { FULFILMENT, METHOD, placed } from '../orders'
import { download, type Cell } from '../csv'

const route = useRoute()
const router = useRouter()

const TABS: { status: FulfilmentStatus | ''; label: string }[] = [
  { status: '', label: 'All' },
  { status: 'pending', label: 'To ship' },
  { status: 'shipped', label: 'Shipped' },
  { status: 'delivered', label: 'Delivered' },
  { status: 'cancelled', label: 'Cancelled' },
]

type Filter = OrderFilter & { merchant?: string }
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const filter = computed<Filter>(() => ({
  status: str(route.query.status) as FulfilmentStatus | '',
  merchant: str(route.query.merchant),
  q: str(route.query.q),
  from: str(route.query.from),
  to: str(route.query.to),
}))
const form = ref({ q: '', from: '', to: '', merchant: '' })

const merchants = ref<MerchantName[]>([])
const nameOf = (id: string) => merchants.value.find((m) => m.id === id)?.name ?? id
onMounted(async () => (merchants.value = await merchantNames()))

const orders = ref<PlatformOrderSummary[]>([])
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
  const { body } = await platformOrders({ ...filter.value, before })
  if (mine !== latest) return
  if (isError(body)) error.value = body.error
  else if ('orders' in body) {
    orders.value = before ? [...orders.value, ...body.orders] : body.orders
    next.value = body.next
  } else error.value = 'Something went wrong. Reload and try again.'
  loading.value = false
  more.value = false
}

watch(
  filter,
  (f) => {
    if (route.path !== '/platform/orders') return
    form.value = { q: f.q ?? '', from: f.from ?? '', to: f.to ?? '', merchant: f.merchant ?? '' }
    void load()
  },
  { immediate: true },
)

const go = (patch: Partial<Filter>) => {
  const q = Object.fromEntries(Object.entries({ ...filter.value, ...patch }).filter(([, v]) => v))
  void router.replace({ query: q })
}
const apply = () => go({ q: form.value.q.trim(), from: form.value.from, to: form.value.to, merchant: form.value.merchant })
const clear = () => void router.replace({ query: filter.value.status ? { status: filter.value.status } : {} })
const filtered = computed(() => Boolean(filter.value.q || filter.value.from || filter.value.to || filter.value.merchant))

const statusLabel = (o: PlatformOrderSummary) => o.fulfilment.map((f) => FULFILMENT[f]?.label ?? f).join(' · ')
const sellers = (o: PlatformOrderSummary) => o.merchantIds.map(nameOf).join(', ')

/** Page by page, one row per order and currency. No name, address, email or phone. */
async function exportCsv() {
  exporting.value = true
  error.value = null
  const rows: Cell[][] = [['Order', 'Placed (UTC)', 'Merchants', 'Status', 'Items', 'Shipping', 'Currency', 'Goods']]
  let before: string | null = null
  // One filter for the whole export, whatever the page's does meanwhile.
  const f = { ...filter.value }
  try {
    do {
      const { body } = await platformOrders({ ...f, before, limit: 200 })
      if (!('orders' in body)) {
        error.value = isError(body) ? body.error : 'The export stopped part way. Try again.'
        return
      }
      for (const o of body.orders) {
        for (const t of o.totals) {
          rows.push([o.id, placed(o.placedAt), sellers(o), statusLabel(o), o.items, METHOD[o.method] ?? o.method, t.currency, minorToDecimal(t.minor)])
        }
      }
      before = body.next
    } while (before)
    download(`platform-orders-${new Date().toISOString().slice(0, 10)}.csv`, rows)
  } finally {
    exporting.value = false
  }
}
</script>

<template>
  <div class="mb-6 flex flex-wrap items-center justify-between gap-3">
    <h1 class="font-display text-xl font-bold text-text-primary">All orders</h1>
    <button class="btn-ghost inline-flex items-center gap-2 px-3 py-2" :disabled="exporting || loading" @click="exportCsv">
      <Download class="h-4 w-4" aria-hidden="true" />{{ exporting ? 'Exporting…' : 'Export CSV' }}
    </button>
  </div>

  <nav class="-mx-4 mb-4 flex gap-1 overflow-x-auto px-4 md:mx-0 md:px-0" aria-label="Fulfilment status">
    <button
      v-for="t in TABS"
      :key="t.status"
      class="whitespace-nowrap rounded-full border px-3 py-1.5 text-sm transition-colors"
      :class="filter.status === t.status ? 'border-accent bg-surface-2 text-text-primary' : 'border-border-hairline text-text-secondary hover:text-text-primary'"
      :aria-current="filter.status === t.status ? 'true' : undefined"
      @click="go({ status: t.status })"
    >
      {{ t.label }}
    </button>
  </nav>

  <form class="mb-6 flex flex-wrap items-end gap-3" @submit.prevent="apply">
    <div class="min-w-[10rem] flex-1">
      <label class="label mb-1 block" for="porders-q">Order id</label>
      <input id="porders-q" v-model="form.q" class="input" type="search" maxlength="40" placeholder="NX-…" />
    </div>
    <div class="min-w-[10rem] flex-1 sm:flex-none">
      <label class="label mb-1 block" for="porders-merchant">Merchant</label>
      <select id="porders-merchant" v-model="form.merchant" class="input">
        <option value="">All merchants</option>
        <option v-for="m in merchants" :key="m.id" :value="m.id">{{ m.name }}</option>
      </select>
    </div>
    <div class="min-w-[9rem] flex-1 sm:flex-none">
      <label class="label mb-1 block" for="porders-from">From</label>
      <input id="porders-from" v-model="form.from" class="input" type="date" />
    </div>
    <div class="min-w-[9rem] flex-1 sm:flex-none">
      <label class="label mb-1 block" for="porders-to">To</label>
      <input id="porders-to" v-model="form.to" class="input" type="date" />
    </div>
    <button class="btn-primary" type="submit" :disabled="loading">Search</button>
    <button v-if="filtered" class="btn-ghost" type="button" @click="clear">Clear</button>
  </form>

  <p v-if="error" class="mb-4 text-sm text-accent-amber" role="alert">{{ error }}</p>
  <p v-if="loading" class="text-text-secondary">Loading…</p>
  <p v-else-if="!error && orders.length === 0" class="card p-6 text-text-secondary">No paid orders match.</p>
  <template v-else-if="orders.length">
    <ul class="card divide-y divide-border-hairline sm:hidden">
      <li v-for="o in orders" :key="o.id">
        <router-link :to="`/platform/orders/${o.id}`" class="flex flex-col gap-1 px-4 py-3 hover:bg-surface-2">
          <span class="flex items-baseline justify-between gap-3">
            <span class="font-mono text-xs text-accent">{{ o.id }}</span>
            <span class="nums text-sm text-text-primary">{{ formatAmounts(o.totals) }}</span>
          </span>
          <span class="truncate text-xs text-text-primary">{{ sellers(o) }}</span>
          <span class="nums text-xs text-text-secondary">
            {{ placed(o.placedAt) }} UTC · {{ o.items }} item{{ o.items === 1 ? '' : 's' }}
            <template v-for="(f, i) in o.fulfilment" :key="i"> · {{ FULFILMENT[f]?.label ?? f }}</template>
          </span>
        </router-link>
      </li>
    </ul>
    <div class="card hidden overflow-x-auto sm:block">
      <table class="w-full text-left text-sm">
        <thead class="border-b border-border-hairline">
          <tr class="label">
            <th class="px-4 py-3 font-medium">Order</th>
            <th class="px-4 py-3 font-medium">Placed (UTC)</th>
            <th class="px-4 py-3 font-medium">Merchants</th>
            <th class="px-4 py-3 font-medium">Items</th>
            <th class="px-4 py-3 font-medium">Goods</th>
            <th class="px-4 py-3 font-medium">Parts</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="o in orders" :key="o.id" class="border-b border-border-hairline last:border-0 hover:bg-surface-2">
            <td class="px-4 py-3">
              <router-link :to="`/platform/orders/${o.id}`" class="whitespace-nowrap font-mono text-xs text-accent hover:text-accent-hover">{{ o.id }}</router-link>
            </td>
            <td class="nums whitespace-nowrap px-4 py-3 text-text-secondary">{{ placed(o.placedAt) }}</td>
            <td class="px-4 py-3 text-text-primary">{{ sellers(o) }}</td>
            <td class="nums px-4 py-3 text-text-secondary">{{ o.items }}</td>
            <td class="nums whitespace-nowrap px-4 py-3 text-text-primary">{{ formatAmounts(o.totals) }}</td>
            <td class="px-4 py-3">
              <span
                v-for="(f, i) in o.fulfilment"
                :key="i"
                class="mr-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs"
                :class="FULFILMENT[f]?.badge"
              >{{ FULFILMENT[f]?.label ?? f }}</span>
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
