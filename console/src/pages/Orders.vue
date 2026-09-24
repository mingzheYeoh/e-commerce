<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { listOrders, isError, type OrderSummary } from '../api'
import { formatAmounts } from '../money'
import { METHOD, STATUS, placed } from '../orders'

const orders = ref<OrderSummary[]>([])
// The worker stops at 1000 orders and says so; a partial list must not pass for the whole range.
const truncated = ref(false)
const from = ref('')
const to = ref('')
const error = ref<string | null>(null)
const loading = ref(true)

async function load() {
  loading.value = true
  error.value = null
  const { body } = await listOrders({ from: from.value, to: to.value })
  if (isError(body)) error.value = body.error
  else if ('orders' in body) {
    orders.value = body.orders
    truncated.value = body.truncated
    // The worker's defaults (the last 30 days) shown back in the inputs.
    from.value = body.from
    to.value = body.to
  } else error.value = 'Something went wrong. Reload and try again.'
  loading.value = false
}

onMounted(load)
</script>

<template>
  <h1 class="mb-6 font-display text-xl font-bold text-text-primary">Orders</h1>

  <form class="mb-6 flex flex-wrap items-end gap-3" @submit.prevent="load">
    <div class="min-w-[9rem] flex-1 sm:flex-none">
      <label class="label mb-1 block" for="orders-from">From</label>
      <input id="orders-from" v-model="from" class="input" type="date" required />
    </div>
    <div class="min-w-[9rem] flex-1 sm:flex-none">
      <label class="label mb-1 block" for="orders-to">To</label>
      <input id="orders-to" v-model="to" class="input" type="date" required />
    </div>
    <button class="btn-primary" type="submit" :disabled="loading">Show</button>
  </form>

  <p v-if="!error && !loading && truncated" class="mb-4 text-sm text-accent-amber" role="status">
    Showing the newest {{ orders.length }} orders only. Narrow the dates to see the rest.
  </p>
  <p v-if="error" class="text-sm text-accent-amber">{{ error }}</p>
  <p v-else-if="loading" class="text-text-secondary">Loading…</p>
  <p v-else-if="orders.length === 0" class="card p-6 text-text-secondary">No paid orders in this range.</p>
  <ul v-else class="card divide-y divide-border-hairline sm:hidden">
    <!-- A phone gets one tappable row per order; the table below needs more width than it has. -->
    <li v-for="o in orders" :key="o.id">
      <router-link :to="`/orders/${o.id}`" class="flex flex-col gap-1 px-4 py-3 hover:bg-surface-2">
        <span class="flex items-baseline justify-between gap-3">
          <span class="font-mono text-xs text-accent">{{ o.id }}</span>
          <span class="nums text-sm text-text-primary">{{ formatAmounts(o.totals) }}</span>
        </span>
        <span class="nums text-xs text-text-secondary">
          {{ placed(o.placedAt) }} UTC · {{ o.items }} item{{ o.items === 1 ? '' : 's' }} · {{ METHOD[o.method] ?? o.method }}
        </span>
      </router-link>
    </li>
  </ul>
  <div v-if="!error && !loading && orders.length" class="card hidden overflow-x-auto sm:block">
    <table class="w-full text-left text-sm">
      <thead class="border-b border-border-hairline">
        <tr class="label">
          <th class="px-4 py-3 font-medium">Order</th>
          <th class="px-4 py-3 font-medium">Placed (UTC)</th>
          <th class="px-4 py-3 font-medium">Items</th>
          <th class="px-4 py-3 font-medium">Your total</th>
          <th class="px-4 py-3 font-medium">Shipping</th>
          <th class="px-4 py-3 font-medium">Status</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="o in orders" :key="o.id" class="border-b border-border-hairline last:border-0 hover:bg-surface-2">
          <td class="px-4 py-3">
            <router-link :to="`/orders/${o.id}`" class="whitespace-nowrap font-mono text-xs text-accent hover:text-accent-hover">{{ o.id }}</router-link>
          </td>
          <td class="nums px-4 py-3 text-text-secondary">{{ placed(o.placedAt) }}</td>
          <td class="nums px-4 py-3 text-text-secondary">{{ o.items }}</td>
          <td class="nums px-4 py-3 text-text-primary">{{ formatAmounts(o.totals) }}</td>
          <td class="px-4 py-3 text-text-secondary">{{ METHOD[o.method] ?? o.method }}</td>
          <td class="px-4 py-3 text-text-secondary">{{ STATUS[o.status] ?? o.status }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
