<script setup lang="ts">
// Reading this page is itself audited by the worker, filtered reads against
// the merchant filtered to — so the newest row is often this view's own.
import { onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { auditLog, allMerchants, isError, type AuditEntry, type MerchantSummary } from '../api'

const route = useRoute()
const router = useRouter()

const entries = ref<AuditEntry[]>([])
const merchants = ref<MerchantSummary[]>([])
const hasMore = ref(false)
const error = ref<string | null>(null)
const loading = ref(true)

const merchant = () => (typeof route.query.merchant === 'string' && route.query.merchant) || null
const page = () => Math.max(0, Number(route.query.page) || 0)

async function load() {
  loading.value = true
  error.value = null
  const { body } = await auditLog(merchant(), page())
  if (isError(body)) error.value = body.error
  else if ('entries' in body) {
    entries.value = body.entries
    hasMore.value = body.hasMore
  } else error.value = 'Something went wrong. Reload and try again.'
  loading.value = false
}

// The filter and page live in the URL, so a link from the merchants page lands filtered.
const go = (merchantId: string | null, p: number) =>
  router.push({ query: { ...(merchantId ? { merchant: merchantId } : {}), ...(p ? { page: String(p) } : {}) } })

// Only while still on this page: leaving it changes the route too, and a
// stray reload there would be one more audited read nobody looked at.
watch(
  () => route.fullPath,
  () => route.path === '/platform/audit' && load(),
)
onMounted(async () => {
  await load()
  const { body } = await allMerchants()
  if (!isError(body) && 'merchants' in body) merchants.value = body.merchants
})
</script>

<template>
  <h1 class="mb-6 font-display text-xl font-bold text-text-primary">Audit log</h1>

  <!-- Keyed so it is re-created once the options arrive and shows the filter from the URL. -->
  <div class="mb-6 max-w-xs">
    <label class="label mb-1 block" for="audit-merchant">Merchant</label>
    <select
      id="audit-merchant"
      :key="merchants.length"
      class="input"
      :value="merchant() ?? ''"
      @change="go(($event.target as HTMLSelectElement).value || null, 0)"
    >
      <option value="">All merchants</option>
      <option v-for="m in merchants" :key="m.id" :value="m.id">{{ m.name }}</option>
    </select>
  </div>

  <p v-if="error" class="text-sm text-accent-amber">{{ error }}</p>
  <p v-else-if="loading" class="text-text-secondary">Loading…</p>
  <p v-else-if="entries.length === 0" class="card p-6 text-text-secondary">Nothing recorded.</p>
  <ul v-else class="card divide-y divide-border-hairline">
    <!-- Two lines per entry rather than a five-column table, so it reads at 390px without sideways scrolling. -->
    <li v-for="e in entries" :key="e.id" class="px-4 py-2.5">
      <p class="flex flex-wrap items-baseline justify-between gap-x-4">
        <span class="font-mono text-xs text-text-primary">{{ e.action }}</span>
        <span class="nums text-xs text-text-muted">{{ e.at }} UTC</span>
      </p>
      <p class="mt-0.5 break-words text-xs text-text-secondary">
        {{ e.actorEmail ?? e.actorId }} ({{ e.actorScope }})<template v-if="e.merchantName"> · {{ e.merchantName }}</template
        ><template v-if="e.subject"> · <span class="code">{{ e.subject }}</span></template>
      </p>
    </li>
  </ul>

  <nav class="mt-4 flex items-center justify-between" aria-label="Pages">
    <button class="btn-ghost" :disabled="page() === 0 || loading" @click="go(merchant(), page() - 1)">Newer</button>
    <span class="nums text-xs text-text-muted">Page {{ page() + 1 }}</span>
    <button class="btn-ghost" :disabled="!hasMore || loading" @click="go(merchant(), page() + 1)">Older</button>
  </nav>
</template>
