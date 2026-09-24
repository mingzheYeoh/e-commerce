<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import AppHeader from '../components/AppHeader.vue'
import { listProducts, isError, type Product } from '../api'
import { formatMinor } from '../money'

const router = useRouter()
const products = ref<Product[]>([])
const error = ref<string | null>(null)
const loading = ref(true)

onMounted(async () => {
  const { body } = await listProducts()
  if (isError(body)) error.value = body.error
  else products.value = body.products
  loading.value = false
})
</script>

<template>
  <div class="mx-auto max-w-4xl px-6 py-10">
    <AppHeader />
    <div class="mb-6 flex items-center justify-between">
      <h1 class="text-lg font-semibold text-text-primary">Products</h1>
      <router-link to="/products/new" class="btn-primary">New product</router-link>
    </div>

    <p v-if="loading" class="text-text-secondary">Loading…</p>
    <p v-else-if="error" class="text-sm text-accent-amber">{{ error }}</p>
    <p v-else-if="products.length === 0" class="card p-6 text-text-secondary">
      No products yet. Create your first one to get started.
    </p>
    <div v-else class="card overflow-hidden">
      <table class="w-full text-left text-sm">
        <thead class="border-b border-border-hairline">
          <tr class="label">
            <th class="px-4 py-3 font-medium">Title</th>
            <th class="px-4 py-3 font-medium">Price</th>
            <th class="px-4 py-3 font-medium">Stock</th>
            <th class="px-4 py-3 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="p in products"
            :key="p.id"
            class="cursor-pointer border-b border-border-hairline last:border-0 hover:bg-surface-2"
            @click="router.push(`/products/${p.id}`)"
          >
            <td class="px-4 py-3 text-text-primary">{{ p.title }}</td>
            <td class="nums px-4 py-3 text-text-primary">{{ formatMinor(p.priceMinor, p.currency) }}</td>
            <td class="nums px-4 py-3 text-text-secondary">{{ p.stockCount }}</td>
            <td class="px-4 py-3 capitalize text-text-secondary">{{ p.status }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
