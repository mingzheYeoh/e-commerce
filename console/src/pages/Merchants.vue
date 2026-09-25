<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { allMerchants, setMerchantStatus, isError, type MerchantSummary } from '../api'
import { formatAmounts } from '../money'

const merchants = ref<MerchantSummary[]>([])
const error = ref<string | null>(null)
const loading = ref(true)
const busy = reactive<Record<string, boolean>>({})
const rowError = reactive<Record<string, string>>({})

onMounted(async () => {
  const { body } = await allMerchants()
  if (isError(body)) error.value = body.error
  else if ('merchants' in body) merchants.value = body.merchants
  else error.value = 'Something went wrong. Reload and try again.'
  loading.value = false
})

async function toggle(m: MerchantSummary) {
  const action = m.status === 'active' ? 'suspend' : 'restore'
  // Staff stay signed in; every console page they open is refused with "this
  // merchant is not active" until the merchant is restored.
  if (
    action === 'suspend' &&
    !window.confirm(
      `Suspend ${m.name}?\n\n` +
        'Their products leave the storefront and can no longer be ordered. ' +
        "Their staff keep their sign-in but can't open anything in the console until you restore them - " +
        "including the delivery addresses of orders they have already been paid for.",
    )
  ) {
    return
  }
  rowError[m.id] = ''
  busy[m.id] = true
  try {
    const { body } = await setMerchantStatus(m.id, action)
    if (isError(body)) rowError[m.id] = body.error
    else if ('status' in body) m.status = body.status
  } finally {
    busy[m.id] = false
  }
}

const BADGE: Record<string, string> = {
  active: 'border-accent-green/40 text-accent-green',
  suspended: 'border-accent-amber/40 text-accent-amber',
  pending: 'border-border-strong text-text-secondary',
}
</script>

<template>
  <h1 class="mb-6 font-display text-xl font-bold text-text-primary">Merchants</h1>

  <p v-if="loading" class="text-text-secondary">Loading…</p>
  <p v-else-if="error" class="text-sm text-accent-amber">{{ error }}</p>
  <p v-else-if="merchants.length === 0" class="card p-6 text-text-secondary">No merchants yet.</p>
  <ul v-else class="card divide-y divide-border-hairline">
    <!-- A wrapping row rather than a table: at 390px a table pushes the actions off-screen. -->
    <li v-for="m in merchants" :key="m.id" class="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
      <div class="min-w-[10rem] flex-1">
        <p class="text-text-primary">
          {{ m.name }}
          <span class="ml-2 rounded-full border px-2 py-0.5 align-middle text-xs capitalize" :class="BADGE[m.status]">{{ m.status }}</span>
        </p>
        <p class="code mt-0.5">{{ m.slug }} · joined {{ m.createdAt.slice(0, 10) }}</p>
      </div>
      <div class="nums text-sm text-text-secondary">{{ m.productCount }} product{{ m.productCount === 1 ? '' : 's' }}</div>
      <div class="nums min-w-[8rem] text-sm text-text-primary">
        {{ formatAmounts(m.revenue) }} <span class="text-xs text-text-muted">net, 30 days</span>
      </div>
      <div class="ml-auto flex gap-2">
        <router-link :to="{ path: '/platform/audit', query: { merchant: m.id } }" class="btn-ghost px-3 py-1.5 text-xs">
          Audit
        </router-link>
        <!-- Pending leaves only through approval, never through restore. -->
        <router-link v-if="m.status === 'pending'" to="/platform/applications" class="btn-ghost px-3 py-1.5 text-xs">
          Review
        </router-link>
        <button v-else class="btn-ghost px-3 py-1.5 text-xs" :disabled="busy[m.id]" @click="toggle(m)">
          {{ m.status === 'active' ? 'Suspend' : 'Restore' }}
        </button>
      </div>
      <p v-if="rowError[m.id]" class="w-full text-right text-xs text-accent-amber">{{ rowError[m.id] }}</p>
    </li>
  </ul>
</template>
