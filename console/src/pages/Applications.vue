<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { pendingMerchants, approveMerchant, isError, type PendingMerchant } from '../api'

const merchants = ref<PendingMerchant[]>([])
const slugs = reactive<Record<string, string>>({})
const errors = reactive<Record<string, string>>({})
const approving = reactive<Record<string, boolean>>({})
const loading = ref(true)
const loadError = ref<string | null>(null)

/** A starting guess at the address the worker's own `isSlug` will accept —
 * lowercase letters, digits and hyphens only — left editable before approving. */
function suggestSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

onMounted(async () => {
  const { body } = await pendingMerchants()
  if (isError(body)) {
    loadError.value = body.error
  } else {
    merchants.value = body.merchants
    for (const m of body.merchants) slugs[m.id] = suggestSlug(m.name)
  }
  loading.value = false
})

async function approve(id: string) {
  errors[id] = ''
  approving[id] = true
  try {
    const { body } = await approveMerchant(id, slugs[id] ?? '')
    if (isError(body)) errors[id] = body.error
    else merchants.value = merchants.value.filter((m) => m.id !== id)
  } finally {
    approving[id] = false
  }
}
</script>

<template>
  <div class="max-w-3xl">
    <h1 class="mb-6 font-display text-xl font-bold text-text-primary">Pending applications</h1>

    <p v-if="loading" class="text-text-secondary">Loading…</p>
    <p v-else-if="loadError" class="text-sm text-accent-amber">{{ loadError }}</p>
    <p v-else-if="merchants.length === 0" class="card p-6 text-text-secondary">
      No pending applications right now.
    </p>
    <div v-else class="flex flex-col gap-4">
      <div v-for="m in merchants" :key="m.id" class="card flex flex-col gap-3 p-4">
        <div>
          <p class="font-medium text-text-primary">{{ m.name }}</p>
          <p class="text-sm text-text-secondary">{{ m.email }}</p>
        </div>
        <div class="flex items-end gap-3">
          <div class="flex-1">
            <label class="label mb-1 block" :for="`slug-${m.id}`">Storefront address</label>
            <input :id="`slug-${m.id}`" v-model="slugs[m.id]" class="input" type="text" maxlength="40" />
          </div>
          <button class="btn-primary" :disabled="approving[m.id]" @click="approve(m.id)">
            {{ approving[m.id] ? 'Approving…' : 'Approve' }}
          </button>
        </div>
        <p v-if="errors[m.id]" class="text-sm text-accent-amber">{{ errors[m.id] }}</p>
      </div>
    </div>
  </div>
</template>
