<script setup lang="ts">
// Return requests: a merchant's own queue, or every merchant's for the
// platform (read-only). Open first, since those are the ones waiting.
import { ref, watch } from 'vue'
import { listReturns, isError, type ReturnStatus, type ReturnSummary, type Scope } from '../api'
import { formatMinor } from '../money'
import { REASON, RETURN_STATUS, placed } from '../orders'

const props = defineProps<{ scope: Scope }>()

const TABS: { status: ReturnStatus | ''; label: string }[] = [
  { status: 'open', label: 'Open' },
  { status: 'approved', label: 'Approved' },
  { status: 'rejected', label: 'Rejected' },
  { status: '', label: 'All' },
]
const tab = ref<ReturnStatus | ''>('open')
const rows = ref<ReturnSummary[]>([])
const error = ref<string | null>(null)
const loading = ref(true)

let latest = 0
async function load() {
  const mine = ++latest
  loading.value = true
  error.value = null
  const { body } = await listReturns(props.scope, tab.value)
  if (mine !== latest) return
  if (isError(body)) error.value = body.error
  else if ('returns' in body) rows.value = body.returns
  else error.value = 'Something went wrong. Reload and try again.'
  loading.value = false
}
watch(tab, load, { immediate: true })

const base = () => (props.scope === 'platform' ? '/platform/returns' : '/returns')
</script>

<template>
  <div class="flex flex-col gap-6">
    <header>
      <h1 class="font-display text-xl font-bold text-text-primary">Returns</h1>
      <p class="mt-1 text-sm text-text-secondary">
        <template v-if="scope === 'platform'">Every merchant's return requests. Deciding one is the merchant's call.</template>
        <template v-else>Shoppers asking for money back on a delivered order. Approving refunds them through the usual refund path.</template>
      </p>
    </header>

    <nav class="flex flex-wrap gap-2" aria-label="Status">
      <button
        v-for="t in TABS"
        :key="t.label"
        type="button"
        class="rounded-full border px-3 py-1 text-sm"
        :class="tab === t.status ? 'border-accent text-text-primary' : 'border-border-hairline text-text-secondary hover:text-text-primary'"
        :aria-pressed="tab === t.status"
        @click="tab = t.status"
      >{{ t.label }}</button>
    </nav>

    <p v-if="error" class="text-sm text-accent-amber">{{ error }}</p>
    <p v-else-if="loading" class="text-text-secondary">Loading…</p>
    <p v-else-if="!rows.length" class="text-sm text-text-secondary">Nothing here.</p>
    <section v-else class="card overflow-x-auto">
      <table class="w-full text-left text-sm">
        <thead class="border-b border-border-hairline">
          <tr class="label">
            <th class="px-4 py-3 font-medium">Order</th>
            <th class="px-4 py-3 font-medium">Reason</th>
            <th class="hidden px-4 py-3 font-medium sm:table-cell">Asked</th>
            <th v-if="scope === 'platform'" class="hidden px-4 py-3 font-medium md:table-cell">Merchant</th>
            <th class="px-4 py-3 text-right font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.id" class="border-b border-border-hairline last:border-0">
            <td class="px-4 py-3">
              <router-link :to="`${base()}/${r.id}`" class="font-mono text-text-primary hover:text-accent">{{ r.orderId }}</router-link>
            </td>
            <td class="px-4 py-3 text-text-secondary">{{ REASON[r.reason] ?? r.reason }}</td>
            <td class="nums hidden px-4 py-3 text-text-secondary sm:table-cell">{{ placed(r.createdAt) }}</td>
            <td v-if="scope === 'platform'" class="hidden px-4 py-3 font-mono text-xs text-text-secondary md:table-cell">{{ r.merchantId }}</td>
            <td class="px-4 py-3 text-right">
              <span class="rounded-full border px-2 py-0.5 text-xs" :class="RETURN_STATUS[r.status]?.badge">
                {{ RETURN_STATUS[r.status]?.label ?? r.status }}
              </span>
              <p v-if="r.refundMinor" class="nums mt-1 text-xs text-text-secondary">{{ formatMinor(r.refundMinor, r.currency) }}</p>
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>
