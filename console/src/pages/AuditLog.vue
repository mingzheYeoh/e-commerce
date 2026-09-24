<script setup lang="ts">
// Reading this page is itself audited by the worker — one row per page read,
// against the merchant filtered to — so the newest row is often this view's own.
// The filter's merchant names come with the page for the same reason: fetching
// the merchant list would write a row per merchant into the log being read.
import { onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { auditLog, isError, type AuditEntry } from '../api'

const route = useRoute()
const router = useRouter()

const entries = ref<AuditEntry[]>([])
const merchants = ref<{ id: string; name: string }[]>([])
const next = ref<number | null>(null)
const error = ref<string | null>(null)
const loading = ref(true)

const merchant = () => (typeof route.query.merchant === 'string' && route.query.merchant) || null
/** The cursor: only entries older than this. Absent means the newest page. */
const before = () => {
  const n = Number(route.query.before)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

async function load() {
  loading.value = true
  error.value = null
  const { status, body } = await auditLog(merchant(), before())
  if (status === 404) error.value = 'No merchant with that id.'
  else if (isError(body)) error.value = body.error
  else if ('entries' in body) {
    entries.value = body.entries
    merchants.value = body.merchants
    next.value = body.next
  } else error.value = 'Something went wrong. Reload and try again.'
  loading.value = false
}

// Filter and cursor live in the URL, so a link from the merchants page lands
// filtered, and the browser's Back button is "Newer".
const go = (merchantId: string | null, cursor: number | null) =>
  router.push({
    query: { ...(merchantId ? { merchant: merchantId } : {}), ...(cursor !== null ? { before: String(cursor) } : {}) },
  })

// Only while still on this page: leaving it changes the route too, and a
// stray reload there would be one more audited read nobody looked at.
watch(
  () => route.fullPath,
  () => route.path === '/platform/audit' && load(),
)
onMounted(load)
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
      @change="go(($event.target as HTMLSelectElement).value || null, null)"
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
    <button class="btn-ghost" :disabled="before() === null || loading" @click="go(merchant(), null)">Newest</button>
    <button class="btn-ghost" :disabled="next === null || loading" @click="go(merchant(), next)">Older</button>
  </nav>
</template>
