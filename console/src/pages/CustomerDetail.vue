<script setup lang="ts">
// One shopper account and its paid orders. Opening it is an audited read.
import { onMounted, ref } from 'vue'
import { customer, isError, type CustomerDetail } from '../api'
import { formatAmounts, formatMinor } from '../money'
import { FULFILMENT, placed } from '../orders'

const props = defineProps<{ id: string }>()
const c = ref<CustomerDetail | null>(null)
const error = ref<string | null>(null)

onMounted(async () => {
  const { status, body } = await customer(props.id)
  if (status === 404) error.value = 'No account with that id.'
  else if (isError(body)) error.value = body.error
  else if ('recent' in body) c.value = body
  else error.value = 'Something went wrong. Reload and try again.'
})
</script>

<template>
  <router-link to="/platform/customers" class="mb-4 inline-block text-sm text-text-secondary hover:text-text-primary">← Customers</router-link>

  <p v-if="error" class="text-sm text-accent-amber" role="alert">{{ error }}</p>
  <p v-else-if="!c" class="text-text-secondary">Loading…</p>
  <div v-else class="flex flex-col gap-6">
    <header>
      <h1 class="font-display text-xl font-bold text-text-primary">{{ c.name }}</h1>
      <p class="break-words text-sm text-text-secondary">{{ c.email }}</p>
    </header>

    <section class="grid grid-cols-1 gap-3 xs:grid-cols-2 lg:grid-cols-4">
      <div class="card p-4">
        <p class="label">Signed up</p>
        <p class="nums mt-1 text-text-primary">{{ placed(c.createdAt) }} UTC</p>
      </div>
      <div class="card p-4">
        <p class="label">Account</p>
        <p class="mt-1 text-text-primary">{{ c.verified ? 'Email verified' : 'Email not verified' }}</p>
        <p class="text-xs text-text-secondary">Two-factor {{ c.twoFactor ? 'on' : 'off' }}</p>
      </div>
      <div class="card p-4">
        <p class="label">Spend · {{ c.orders }} order{{ c.orders === 1 ? '' : 's' }}</p>
        <p class="nums mt-1 break-words text-text-primary">{{ formatAmounts(c.spend) }}</p>
      </div>
      <div class="card p-4">
        <p class="label">Refunded</p>
        <p class="nums mt-1 break-words text-text-primary">{{ formatAmounts(c.refunded) }}</p>
      </div>
    </section>

    <section class="card">
      <h2 class="border-b border-border-hairline p-4 text-sm font-semibold text-text-primary">
        Orders<template v-if="c.recent.length < c.orders">, latest {{ c.recent.length }}</template>
      </h2>
      <p v-if="c.recent.length === 0" class="p-4 text-sm text-text-secondary">No paid orders placed while signed in.</p>
      <div v-else class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="border-b border-border-hairline">
            <tr class="label">
              <th class="px-4 py-3 font-medium">Order</th>
              <th class="px-4 py-3 font-medium">Placed (UTC)</th>
              <th class="px-4 py-3 text-right font-medium">Items</th>
              <th class="px-4 py-3 text-right font-medium">Charged</th>
              <th class="px-4 py-3 font-medium">Parts</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="o in c.recent" :key="o.id" class="border-b border-border-hairline last:border-0">
              <td class="px-4 py-3">
                <router-link :to="`/platform/orders/${o.id}`" class="whitespace-nowrap font-mono text-xs text-accent hover:text-accent-hover">{{ o.id }}</router-link>
              </td>
              <td class="nums whitespace-nowrap px-4 py-3 text-text-secondary">{{ placed(o.placedAt) }}</td>
              <td class="nums px-4 py-3 text-right text-text-secondary">{{ o.items }}</td>
              <td class="nums whitespace-nowrap px-4 py-3 text-right text-text-primary">{{ formatMinor(o.total, o.currency) }}</td>
              <td class="px-4 py-3">
                <span v-for="(f, i) in o.fulfilment" :key="i" class="mr-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs" :class="FULFILMENT[f]?.badge">
                  {{ FULFILMENT[f]?.label ?? f }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
