<script setup lang="ts">
// The worker's create route takes only sku/title/brand/category/priceMinor —
// stock and status aren't in that payload, they start at the worker's own
// defaults — so this page hands off to /products/:id on success, where those
// two get set. That keeps this form and the edit form each asking for
// exactly what their endpoint accepts.
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { me, createProduct, isError } from '../api'
import { parsePriceToMinor } from '../money'
import { CATEGORIES } from '../categories'

const router = useRouter()
const sku = ref('')
const title = ref('')
const brand = ref('')
// No default: a preselected Phones is how headphones end up filed as phones.
const category = ref('')
const price = ref('')
const error = ref<string | null>(null)
const submitting = ref(false)

onMounted(async () => {
  const { body } = await me()
  // Brand defaults to the merchant's own name — the seeded catalogue is one
  // brand per merchant — but stays editable.
  if (body.kind === 'active' && body.scope === 'merchant') brand.value = body.merchant.name
})

async function submit() {
  error.value = null
  const priceMinor = parsePriceToMinor(price.value)
  if (priceMinor === null) {
    error.value = 'Enter a price like 19.99.'
    return
  }
  submitting.value = true
  try {
    const { body } = await createProduct({
      sku: sku.value,
      title: title.value,
      brand: brand.value,
      category: category.value,
      priceMinor,
    })
    if (isError(body)) error.value = body.error
    else await router.push(`/products/${body.id}`)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="max-w-2xl">
    <h1 class="mb-6 font-display text-xl font-bold text-text-primary">New product</h1>

    <form class="card flex flex-col gap-4 p-6" @submit.prevent="submit">
      <div>
        <label class="label mb-1 block" for="product-sku">SKU</label>
        <input id="product-sku" v-model="sku" class="input" type="text" required maxlength="64" />
      </div>
      <div>
        <label class="label mb-1 block" for="product-title">Title</label>
        <input id="product-title" v-model="title" class="input" type="text" required maxlength="200" />
      </div>
      <div>
        <label class="label mb-1 block" for="product-brand">Brand</label>
        <input id="product-brand" v-model="brand" class="input" type="text" required maxlength="80" />
      </div>
      <div>
        <label class="label mb-1 block" for="product-category">Category</label>
        <select id="product-category" v-model="category" class="input" required>
          <option value="" disabled>Choose a category</option>
          <option v-for="c in CATEGORIES" :key="c.id" :value="c.id">{{ c.label }}</option>
        </select>
      </div>
      <div>
        <label class="label mb-1 block" for="product-price">Price</label>
        <input
          id="product-price"
          v-model="price"
          class="input"
          type="text"
          inputmode="decimal"
          placeholder="19.99"
          required
        />
      </div>
      <p v-if="error" class="text-sm text-accent-amber">{{ error }}</p>
      <div class="flex gap-3">
        <button class="btn-primary" type="submit" :disabled="submitting">
          {{ submitting ? 'Creating…' : 'Create' }}
        </button>
        <router-link to="/products" class="btn-ghost">Cancel</router-link>
      </div>
    </form>
  </div>
</template>
