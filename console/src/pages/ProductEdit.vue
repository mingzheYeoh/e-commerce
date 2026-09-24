<script setup lang="ts">
// There is no single-product GET, so this loads the merchant's whole list and
// picks the one whose id matches the route — the contract the worker gives
// us, not a route added to it.
import { onMounted, ref } from 'vue'
import AppHeader from '../components/AppHeader.vue'
import { listProducts, updateProduct, isError, type Product, type ProductStatus } from '../api'
import { parsePriceToMinor } from '../money'

const props = defineProps<{ id: string }>()

const product = ref<Product | null>(null)
const notFound = ref(false)
const loading = ref(true)

const title = ref('')
const price = ref('')
const stock = ref('')
const status = ref<ProductStatus>('draft')

const error = ref<string | null>(null)
const saving = ref(false)

onMounted(async () => {
  const { body } = await listProducts()
  const found = isError(body) ? undefined : body.products.find((p) => p.id === props.id)
  if (!found) {
    notFound.value = true
  } else {
    product.value = found
    title.value = found.title
    price.value = (found.priceMinor / 100).toFixed(2)
    stock.value = String(found.stockCount)
    status.value = found.status
  }
  loading.value = false
})

async function submit() {
  error.value = null
  const priceMinor = parsePriceToMinor(price.value)
  if (priceMinor === null) {
    error.value = 'Enter a price like 19.99.'
    return
  }
  const stockCount = Number(stock.value)
  if (!Number.isInteger(stockCount) || stockCount < 0) {
    error.value = 'Stock is a whole number, zero or more.'
    return
  }
  saving.value = true
  try {
    const { body } = await updateProduct(props.id, {
      title: title.value,
      priceMinor,
      stockCount,
      status: status.value,
    })
    if (isError(body)) error.value = body.error
    else product.value = body
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="mx-auto max-w-2xl px-6 py-10">
    <AppHeader />
    <h1 class="mb-6 text-lg font-semibold text-text-primary">Edit product</h1>

    <p v-if="loading" class="text-text-secondary">Loading…</p>
    <p v-else-if="notFound" class="card p-6 text-text-secondary">
      No product with that id.
      <router-link to="/products" class="text-accent">Back to products</router-link>
    </p>
    <form v-else class="card flex flex-col gap-4 p-6" @submit.prevent="submit">
      <p class="text-sm text-text-secondary">
        <span class="code">{{ product?.sku }}</span> · {{ product?.brand }} · {{ product?.category }}
      </p>
      <div>
        <label class="label mb-1 block" for="edit-title">Title</label>
        <input id="edit-title" v-model="title" class="input" type="text" required maxlength="200" />
      </div>
      <div>
        <label class="label mb-1 block" for="edit-price">Price</label>
        <input id="edit-price" v-model="price" class="input" type="text" inputmode="decimal" required />
      </div>
      <div>
        <label class="label mb-1 block" for="edit-stock">Stock</label>
        <input id="edit-stock" v-model="stock" class="input" type="number" min="0" step="1" required />
      </div>
      <div>
        <label class="label mb-1 block" for="edit-status">Status</label>
        <select id="edit-status" v-model="status" class="input">
          <option value="draft">Draft</option>
          <option value="published">Published</option>
          <option value="archived">Archived</option>
        </select>
      </div>
      <p v-if="error" class="text-sm text-accent-amber">{{ error }}</p>
      <div class="flex gap-3">
        <button class="btn-primary" type="submit" :disabled="saving">
          {{ saving ? 'Saving…' : 'Save' }}
        </button>
        <router-link to="/products" class="btn-ghost">Back</router-link>
      </div>
    </form>
  </div>
</template>
