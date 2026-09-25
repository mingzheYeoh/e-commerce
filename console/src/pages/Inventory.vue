<script setup lang="ts">
// Stock for every product, with what sold in the last 30 days. Every stock
// change goes through the ordinary product PATCH, one product per request, so
// its validation, its audit row and the AI index rules are the ones every
// other save meets: this page adds no write of its own.
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { inventory, updateProduct, isError, asProduct, type InventoryItem, type ProductStatus } from '../api'

const route = useRoute()

type Stock = 'all' | 'low' | 'out'
const stock = ref<Stock>(route.query.filter === 'low' || route.query.filter === 'out' ? route.query.filter : 'all')
const status = ref<ProductStatus | ''>('')

const items = ref<InventoryItem[]>([])
const lowAt = ref(5)
const error = ref<string | null>(null)
const loading = ref(true)

/** Typed but not yet saved, by product id. */
const drafts = ref<Record<string, string>>({})
const rowError = ref<Record<string, string>>({})
const saving = ref<Record<string, boolean>>({})
const selected = ref<Set<string>>(new Set())
const bulkValue = ref('')
const bulkNote = ref<string | null>(null)
const bulkBusy = ref(false)

onMounted(async () => {
  const { body } = await inventory()
  if (isError(body)) error.value = body.error
  else if ('products' in body) {
    items.value = body.products
    lowAt.value = body.lowStockAt
  } else error.value = 'Something went wrong. Reload and try again.'
  loading.value = false
})

// Low and out are what the overview counts: products on sale.
const isLow = (p: InventoryItem) => p.status === 'published' && p.stockCount > 0 && p.stockCount <= lowAt.value
const isOut = (p: InventoryItem) => p.status === 'published' && p.stockCount === 0

const shown = computed(() =>
  items.value.filter(
    (p) =>
      (stock.value === 'all' || (stock.value === 'low' ? isLow(p) : isOut(p))) && (!status.value || p.status === status.value),
  ),
)

/** Stock ÷ average daily units over 30 days; nothing to divide by without sales. */
const cover = (p: InventoryItem) => (p.sold30d > 0 ? String(Math.floor((p.stockCount * 30) / p.sold30d)) : '—')

const parseStock = (v: string) => (/^\d{1,9}$/.test(v.trim()) ? Number(v.trim()) : null)

async function setStock(p: InventoryItem, value: number): Promise<boolean> {
  saving.value[p.id] = true
  delete rowError.value[p.id]
  try {
    const { body: raw } = await updateProduct(p.id, { stockCount: value })
    const body = asProduct(raw)
    if (isError(body)) {
      rowError.value[p.id] = body.error
      return false
    }
    p.stockCount = body.stockCount
    delete drafts.value[p.id]
    return true
  } finally {
    saving.value[p.id] = false
  }
}

async function saveRow(p: InventoryItem) {
  const value = parseStock(drafts.value[p.id] ?? '')
  if (value === null) {
    rowError.value[p.id] = 'Stock is a whole number, zero or more.'
    return
  }
  if (value !== p.stockCount) await setStock(p, value)
  else delete drafts.value[p.id]
}

const allShownSelected = computed(() => shown.value.length > 0 && shown.value.every((p) => selected.value.has(p.id)))
function toggleAll() {
  const next = new Set(selected.value)
  for (const p of shown.value) allShownSelected.value ? next.delete(p.id) : next.add(p.id)
  selected.value = next
}
function toggle(id: string) {
  const next = new Set(selected.value)
  next.has(id) ? next.delete(id) : next.add(id)
  selected.value = next
}

/** One request per product, in turn; a refusal is kept on its row and the rest carry on. */
async function applyBulk() {
  const value = parseStock(bulkValue.value)
  if (value === null) {
    bulkNote.value = 'Stock is a whole number, zero or more.'
    return
  }
  bulkBusy.value = true
  bulkNote.value = null
  const targets = items.value.filter((p) => selected.value.has(p.id))
  let failed = 0
  for (const p of targets) if (!(await setStock(p, value))) failed++
  bulkBusy.value = false
  bulkNote.value = failed
    ? `${targets.length - failed} updated, ${failed} refused — see the rows marked below.`
    : `${targets.length} updated.`
  if (!failed) selected.value = new Set()
}
</script>

<template>
  <h1 class="mb-6 font-display text-xl font-bold text-text-primary">Inventory</h1>

  <div class="mb-4 flex flex-wrap items-end gap-3">
    <div class="-mx-4 flex gap-1 overflow-x-auto px-4 md:mx-0 md:px-0" role="group" aria-label="Stock">
      <button
        v-for="f in [
          { id: 'all', label: 'All' },
          { id: 'low', label: `Low stock (≤ ${lowAt})` },
          { id: 'out', label: 'Out of stock' },
        ] as const"
        :key="f.id"
        class="whitespace-nowrap rounded-full border px-3 py-1.5 text-sm transition-colors"
        :class="stock === f.id ? 'border-accent bg-surface-2 text-text-primary' : 'border-border-hairline text-text-secondary hover:text-text-primary'"
        :aria-pressed="stock === f.id"
        @click="stock = f.id"
      >
        {{ f.label }}
      </button>
    </div>
    <div class="ml-auto min-w-[9rem]">
      <label class="label mb-1 block" for="inv-status">Status</label>
      <select id="inv-status" v-model="status" class="input">
        <option value="">Any</option>
        <option value="published">Published</option>
        <option value="draft">Draft</option>
        <option value="archived">Archived</option>
      </select>
    </div>
  </div>

  <form
    v-if="selected.size"
    class="card mb-4 flex flex-wrap items-end gap-3 p-4"
    aria-label="Set stock for the selected products"
    @submit.prevent="applyBulk"
  >
    <p class="w-full text-sm text-text-primary sm:w-auto sm:flex-1">{{ selected.size }} selected</p>
    <div class="w-32">
      <label class="label mb-1 block" for="bulk-stock">Set stock to</label>
      <input id="bulk-stock" v-model="bulkValue" class="input nums" inputmode="numeric" required />
    </div>
    <button class="btn-primary" type="submit" :disabled="bulkBusy">{{ bulkBusy ? 'Saving…' : 'Apply' }}</button>
    <button class="btn-ghost" type="button" :disabled="bulkBusy" @click="selected = new Set()">Clear</button>
  </form>
  <p v-if="bulkNote" class="mb-4 text-sm text-text-secondary" role="status">{{ bulkNote }}</p>

  <p v-if="loading" class="text-text-secondary">Loading…</p>
  <p v-else-if="error" class="text-sm text-accent-amber" role="alert">{{ error }}</p>
  <p v-else-if="items.length === 0" class="card p-6 text-text-secondary">No products yet.</p>
  <p v-else-if="shown.length === 0" class="card p-6 text-text-secondary">Nothing matches this filter.</p>
  <div v-else class="card overflow-x-auto">
    <table class="w-full text-left text-sm">
      <thead class="border-b border-border-hairline">
        <tr class="label">
          <th class="w-10 px-4 py-3">
            <input type="checkbox" :checked="allShownSelected" aria-label="Select every product shown" @change="toggleAll" />
          </th>
          <th class="px-4 py-3 font-medium">Product</th>
          <th class="px-4 py-3 font-medium">Status</th>
          <th class="px-4 py-3 font-medium">Stock</th>
          <th class="px-4 py-3 text-right font-medium">Sold, 30 days</th>
          <th class="px-4 py-3 text-right font-medium" title="Stock divided by average daily units sold over 30 days">Days of cover</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="p in shown" :key="p.id" class="border-b border-border-hairline align-top last:border-0">
          <td class="px-4 py-3">
            <input type="checkbox" :checked="selected.has(p.id)" :aria-label="`Select ${p.title}`" @change="toggle(p.id)" />
          </td>
          <td class="px-4 py-3">
            <router-link :to="`/products/${p.id}`" class="block min-w-[10rem] text-text-primary hover:text-accent">{{ p.title }}</router-link>
            <span class="code">{{ p.sku }}</span>
          </td>
          <td class="px-4 py-3 capitalize text-text-secondary">{{ p.status }}</td>
          <td class="px-4 py-3">
            <form class="flex items-center gap-2" @submit.prevent="saveRow(p)">
              <input
                :value="drafts[p.id] ?? String(p.stockCount)"
                class="input nums h-9 w-20"
                :class="isOut(p) || isLow(p) ? 'text-accent-amber' : ''"
                inputmode="numeric"
                :aria-label="`Stock for ${p.title}`"
                @input="drafts[p.id] = ($event.target as HTMLInputElement).value"
              />
              <button v-if="drafts[p.id] !== undefined" class="btn-secondary px-3 py-1.5" type="submit" :disabled="saving[p.id]">
                {{ saving[p.id] ? '…' : 'Save' }}
              </button>
            </form>
            <p v-if="rowError[p.id]" class="mt-1 max-w-[16rem] text-xs text-accent-amber" role="alert">{{ rowError[p.id] }}</p>
          </td>
          <td class="nums px-4 py-3 text-right text-text-secondary">{{ p.sold30d }}</td>
          <td class="nums px-4 py-3 text-right text-text-secondary">{{ cover(p) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
  <p class="mt-3 text-xs text-text-muted">
    Sold counts units on paid orders in the last 30 days (UTC), less refunded units. Low and out of stock count published products only.
  </p>
</template>
