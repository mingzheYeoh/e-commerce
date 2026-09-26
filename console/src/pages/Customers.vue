<script setup lang="ts">
// Shopper accounts. Personal data: every page read is audited by the worker
// and never cached, and the only export that carries an email is this one.
// Guest checkouts have no account, so they appear only as a total.
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Download } from 'lucide-vue-next'
import { customers, isError, type Amount, type Customer } from '../api'
import { formatAmounts, minorToDecimal } from '../money'
import { placed } from '../orders'
import { download, type Cell } from '../csv'

const route = useRoute()
const router = useRouter()

const q = computed(() => (typeof route.query.q === 'string' ? route.query.q : ''))
const search = ref('')
const list = ref<Customer[]>([])
const guests = ref<{ orders: number; spend: Amount[] } | null>(null)
const next = ref<string | null>(null)
const error = ref<string | null>(null)
const loading = ref(true)
const more = ref(false)
const exporting = ref(false)

async function load(before: string | null = null) {
  error.value = null
  if (before) more.value = true
  else loading.value = true
  const { body } = await customers(q.value, before)
  if (isError(body)) error.value = body.error
  else if ('customers' in body) {
    list.value = before ? [...list.value, ...body.customers] : body.customers
    if (!before) guests.value = body.guests
    next.value = body.next
  } else error.value = 'Something went wrong. Reload and try again.'
  loading.value = false
  more.value = false
}

watch(
  q,
  (v) => {
    if (route.path !== '/platform/customers') return
    search.value = v
    void load()
  },
  { immediate: true },
)

const apply = () => void router.replace({ query: search.value.trim() ? { q: search.value.trim() } : {} })

/** Every account matching the search, page by page. Email and name, never anything that signs in. */
async function exportCsv() {
  if (!window.confirm('Export customer emails and names?\n\nThe file holds personal data. Keep it only as long as you need it.')) return
  exporting.value = true
  error.value = null
  const rows: Cell[][] = [['Customer id', 'Email', 'Name', 'Signed up (UTC)', 'Verified', '2FA', 'Orders', 'Last order (UTC)', 'Currency', 'Spend']]
  let before: string | null = null
  try {
    do {
      const { body } = await customers(q.value, before)
      if (!('customers' in body)) {
        error.value = isError(body) ? body.error : 'The export stopped part way. Try again.'
        return
      }
      for (const c of body.customers) {
        const base: Cell[] = [c.id, c.email, c.name, c.createdAt, c.verified ? 'yes' : 'no', c.twoFactor ? 'yes' : 'no', c.orders, c.lastOrderAt]
        if (c.spend.length) for (const s of c.spend) rows.push([...base, s.currency, minorToDecimal(s.minor)])
        else rows.push([...base, null, null])
      }
      before = body.next
    } while (before)
    download(`customers-${new Date().toISOString().slice(0, 10)}.csv`, rows)
  } finally {
    exporting.value = false
  }
}
</script>

<template>
  <div class="mb-6 flex flex-wrap items-center justify-between gap-3">
    <h1 class="font-display text-xl font-bold text-text-primary">Customers</h1>
    <button class="btn-ghost inline-flex items-center gap-2 px-3 py-2" :disabled="exporting || loading" @click="exportCsv">
      <Download class="h-4 w-4" aria-hidden="true" />{{ exporting ? 'Exporting…' : 'Export CSV' }}
    </button>
  </div>

  <form class="mb-6 flex flex-wrap items-end gap-3" @submit.prevent="apply">
    <div class="min-w-[12rem] flex-1">
      <label class="label mb-1 block" for="customers-q">Email or name</label>
      <input id="customers-q" v-model="search" class="input" type="search" maxlength="80" />
    </div>
    <button class="btn-primary" type="submit" :disabled="loading">Search</button>
    <button v-if="q" class="btn-ghost" type="button" @click="router.replace({ query: {} })">Clear</button>
  </form>

  <p class="mb-4 text-xs text-text-muted">Every view of this page is recorded in the audit log.</p>

  <p v-if="error" class="mb-4 text-sm text-accent-amber" role="alert">{{ error }}</p>
  <p v-if="loading" class="text-text-secondary">Loading…</p>
  <template v-else-if="!error">
    <div v-if="guests && !q" class="card mb-4 flex flex-wrap items-baseline justify-between gap-2 p-4 text-sm">
      <span class="text-text-secondary">Guest checkouts (no account)</span>
      <span class="nums text-text-primary">{{ guests.orders }} order{{ guests.orders === 1 ? '' : 's' }} · {{ formatAmounts(guests.spend) }}</span>
    </div>
    <p v-if="list.length === 0" class="card p-6 text-text-secondary">No accounts match.</p>
    <template v-else>
      <div class="card overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="border-b border-border-hairline">
            <tr class="label">
              <th class="px-4 py-3 font-medium">Customer</th>
              <th class="px-4 py-3 font-medium">Signed up</th>
              <th class="px-4 py-3 font-medium">Account</th>
              <th class="px-4 py-3 text-right font-medium">Orders</th>
              <th class="px-4 py-3 text-right font-medium">Spend</th>
              <th class="px-4 py-3 font-medium">Last order</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in list" :key="c.id" class="border-b border-border-hairline last:border-0 hover:bg-surface-2">
              <td class="px-4 py-3">
                <router-link :to="`/platform/customers/${c.id}`" class="text-text-primary hover:text-accent">{{ c.name }}</router-link>
                <p class="text-xs text-text-secondary">{{ c.email }}</p>
              </td>
              <td class="nums whitespace-nowrap px-4 py-3 text-text-secondary">{{ c.createdAt.slice(0, 10) }}</td>
              <td class="whitespace-nowrap px-4 py-3 text-xs">
                <span :class="c.verified ? 'text-accent-green' : 'text-accent-amber'">{{ c.verified ? 'Verified' : 'Unverified' }}</span>
                <span class="text-text-secondary"> · 2FA {{ c.twoFactor ? 'on' : 'off' }}</span>
              </td>
              <td class="nums px-4 py-3 text-right text-text-secondary">{{ c.orders }}</td>
              <td class="nums whitespace-nowrap px-4 py-3 text-right text-text-primary">{{ formatAmounts(c.spend) }}</td>
              <td class="nums whitespace-nowrap px-4 py-3 text-text-secondary">{{ c.lastOrderAt ? placed(c.lastOrderAt) : '—' }}</td>
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
