<script setup lang="ts">
// Only this merchant's lines and their sum: the worker never sends another
// seller's lines or the order's grand total, so there is nothing here to hide.
import { onMounted, ref } from 'vue'
import { getOrder, isError, type OrderDetail } from '../api'
import { formatAmounts, formatMinor } from '../money'
import { METHOD, STATUS, placed } from '../orders'

const props = defineProps<{ id: string }>()
const order = ref<OrderDetail | null>(null)
const error = ref<string | null>(null)

onMounted(async () => {
  const { status, body } = await getOrder(props.id)
  if (status === 404) error.value = 'No order of yours with that number.'
  else if (isError(body)) error.value = body.error
  else if ('lines' in body) order.value = body
  else error.value = 'Something went wrong. Reload and try again.'
})
</script>

<template>
  <router-link to="/orders" class="mb-4 inline-block text-sm text-text-secondary hover:text-text-primary">← Orders</router-link>

  <p v-if="error" class="text-sm text-accent-amber">{{ error }}</p>
  <p v-else-if="!order" class="text-text-secondary">Loading…</p>
  <div v-else class="flex flex-col gap-6">
    <header class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
      <h1 class="font-mono text-lg font-medium text-text-primary">{{ order.id }}</h1>
      <span class="text-sm text-text-secondary">{{ placed(order.placedAt) }} UTC</span>
      <span class="rounded-full border border-border-hairline px-2 py-0.5 text-xs text-text-secondary">
        {{ STATUS[order.status] ?? order.status }}
      </span>
    </header>

    <div class="grid grid-cols-1 gap-6 md:grid-cols-3">
      <section class="card p-4 md:col-span-1">
        <h2 class="label mb-2">Ship to</h2>
        <address class="text-sm not-italic leading-relaxed text-text-primary">
          {{ order.shipTo.name }}<br />
          {{ order.shipTo.line1 }}<br />
          <template v-if="order.shipTo.line2">{{ order.shipTo.line2 }}<br /></template>
          {{ order.shipTo.city }}<template v-if="order.shipTo.state">, {{ order.shipTo.state }}</template>
          {{ order.shipTo.postal }}<br />
          {{ order.shipTo.country }}
        </address>
        <h2 class="label mb-1 mt-4">Delivery</h2>
        <p class="text-sm text-text-primary">{{ METHOD[order.method] ?? order.method }}</p>
      </section>

      <section class="card md:col-span-2">
        <table class="w-full text-left text-sm">
          <thead class="border-b border-border-hairline">
            <tr class="label">
              <th class="px-4 py-3 font-medium">Your items</th>
              <th class="hidden px-4 py-3 font-medium sm:table-cell">Qty</th>
              <th class="hidden px-4 py-3 text-right font-medium sm:table-cell">Price</th>
              <th class="px-4 py-3 text-right font-medium">Line</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="l in order.lines" :key="`${l.productId}-${l.finish}`" class="border-b border-border-hairline">
              <td class="px-4 py-3">
                <p class="text-text-primary">{{ l.title }}</p>
                <p class="code">{{ l.sku }}<template v-if="l.finish"> · {{ l.finish }}</template></p>
                <p class="nums mt-1 text-xs text-text-secondary sm:hidden">{{ l.qty }} × {{ formatMinor(l.unitMinor, l.currency) }}</p>
              </td>
              <td class="nums hidden px-4 py-3 text-text-secondary sm:table-cell">{{ l.qty }}</td>
              <td class="nums hidden px-4 py-3 text-right text-text-secondary sm:table-cell">{{ formatMinor(l.unitMinor, l.currency) }}</td>
              <td class="nums px-4 py-3 text-right text-text-primary">{{ formatMinor(l.unitMinor * l.qty, l.currency) }}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <td colspan="4" class="px-4 py-3">
                <div class="flex items-baseline justify-end gap-4">
                  <span class="text-text-secondary">Your total</span>
                  <span class="nums font-semibold text-text-primary">{{ formatAmounts(order.totals) }}</span>
                </div>
              </td>
            </tr>
          </tfoot>
        </table>
      </section>
    </div>
  </div>
</template>
