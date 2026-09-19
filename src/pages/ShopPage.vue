<script setup lang="ts">
import { computed, watch } from 'vue'
import { useRoute, useRouter, RouterLink, type LocationQueryRaw } from 'vue-router'
import ProductCard from '@/components/commerce/ProductCard.vue'
import { useCatalogStore, type Filter } from '@/stores/catalog'
import { categories } from '@/data/categories'
import { brands, brandName } from '@/data/brands'

const route = useRoute()
const router = useRouter()
const catalog = useCatalogStore()

const filters: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All products' },
  { id: 'inStock', label: 'In stock' },
  ...categories.map((c) => ({ id: c.id as Filter, label: c.label })),
]

/**
 * URL -> store. The only writer of catalog state.
 * Everything the user clicks goes through `router.push` below, so this watcher
 * is the single place filter state is applied and there is no feedback loop.
 */
watch(
  () => route.query,
  (q) => {
    if (q.stock === 'in') catalog.activeFilter = 'inStock'
    else if (typeof q.category === 'string') catalog.activeFilter = q.category as Filter
    else catalog.activeFilter = 'all'

    catalog.activeBrand = typeof q.brand === 'string' ? q.brand : null
    catalog.dealsOnly = q.deal === '1'
    catalog.sort =
      q.sort === 'price-desc' ? 'priceDesc' : q.sort === 'price-asc' ? 'priceAsc' : 'default'
  },
  { immediate: true },
)

function queryFor(patch: Record<string, string | null>): LocationQueryRaw {
  const next: LocationQueryRaw = { ...route.query }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key]
    else next[key] = value
  }
  return next
}

function applyFilter(id: Filter) {
  if (id === 'all') router.push({ query: queryFor({ category: null, stock: null }) })
  else if (id === 'inStock') router.push({ query: queryFor({ stock: 'in', category: null }) })
  else router.push({ query: queryFor({ category: id, stock: null }) })
}

function setSort(value: string) {
  router.push({ query: queryFor({ sort: value === 'default' ? null : value }) })
}

function setBrand(value: string) {
  router.push({ query: queryFor({ brand: value === 'all' ? null : value }) })
}

const activeLabel = computed(() => {
  if (catalog.activeBrand) return brandName(catalog.activeBrand)
  const match = filters.find((f) => f.id === catalog.activeFilter)
  return match && match.id !== 'all' ? match.label : 'All products'
})
</script>

<template>
  <div class="pt-16">
    <!-- Page header -->
    <div class="border-b border-border-hairline">
      <div class="mx-auto max-w-[1600px] px-4 py-8 md:px-8 md:py-12">
        <nav class="mb-4 text-sm text-text-secondary" aria-label="Breadcrumb">
          <RouterLink to="/" class="transition-colors hover:text-text-primary">Home</RouterLink>
          <span class="mx-2 text-text-muted">/</span>
          <span class="text-text-primary">Shop</span>
        </nav>

        <div class="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 class="text-3xl font-bold md:text-4xl">{{ activeLabel }}</h1>
            <p class="mt-2 text-sm text-text-secondary">
              <span class="nums">{{ catalog.visible.length }}</span>
              {{ catalog.visible.length === 1 ? 'product' : 'products' }}
            </p>
          </div>

          <RouterLink
            v-if="catalog.hasFilters"
            to="/shop"
            class="text-sm font-medium text-accent transition-colors hover:text-accent-hover"
          >
            Clear all filters
          </RouterLink>
        </div>
      </div>
    </div>

    <!-- Filter toolbar. Filters narrow the set and sit on the left; the two
         controls that do not narrow anything — brand picker and sort order —
         are labelled selects on the right, so they read as different things. -->
    <div class="sticky top-16 z-30 border-b border-border-hairline bg-void/90 backdrop-blur-md">
      <div
        class="mx-auto flex max-w-[1600px] flex-col gap-3 px-4 py-3 md:flex-row md:items-center md:justify-between md:px-8"
      >
        <div class="flex items-center gap-2 overflow-x-auto pb-1 md:pb-0">
          <button
            v-for="filter in filters"
            :key="filter.id"
            type="button"
            class="h-9 shrink-0 rounded-full border px-4 text-sm font-medium transition-colors"
            :class="
              catalog.activeFilter === filter.id
                ? 'border-accent bg-accent text-white'
                : 'border-border-hairline text-text-secondary hover:border-border-strong hover:text-text-primary'
            "
            :aria-pressed="catalog.activeFilter === filter.id"
            @click="applyFilter(filter.id)"
          >
            {{ filter.label }}
          </button>
        </div>

        <div class="flex shrink-0 items-center gap-4">
          <div class="flex items-center gap-2">
            <label for="brand-filter" class="text-sm text-text-muted">Brand</label>
            <select
              id="brand-filter"
              :value="catalog.activeBrand ?? 'all'"
              class="h-9 rounded border border-border-hairline bg-surface-1 px-2.5 text-sm text-text-primary transition-colors hover:border-border-strong"
              @change="setBrand(($event.target as HTMLSelectElement).value)"
            >
              <option value="all">All brands</option>
              <option v-for="brand in brands" :key="brand.id" :value="brand.id">
                {{ brand.name }}
              </option>
            </select>
          </div>

          <div class="flex items-center gap-2">
            <label for="sort-order" class="text-sm text-text-muted">Sort</label>
            <select
              id="sort-order"
              :value="catalog.sort === 'priceDesc' ? 'price-desc' : catalog.sort === 'priceAsc' ? 'price-asc' : 'default'"
              class="h-9 rounded border border-border-hairline bg-surface-1 px-2.5 text-sm text-text-primary transition-colors hover:border-border-strong"
              @change="setSort(($event.target as HTMLSelectElement).value)"
            >
              <option value="default">Featured</option>
              <option value="price-asc">Price: low to high</option>
              <option value="price-desc">Price: high to low</option>
            </select>
          </div>
        </div>
      </div>
    </div>

    <!-- Grid -->
    <div class="mx-auto max-w-[1600px] px-4 py-8 md:px-8">
      <TransitionGroup
        tag="div"
        class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        enter-from-class="opacity-0 translate-y-3"
        leave-to-class="opacity-0"
        enter-active-class="transition duration-300"
        leave-active-class="absolute transition duration-200"
        move-class="transition duration-300"
      >
        <ProductCard v-for="product in catalog.visible" :key="product.id" :product="product" />
      </TransitionGroup>

      <div v-if="!catalog.visible.length" class="py-20 text-center">
        <p class="font-medium">No products match these filters.</p>
        <RouterLink to="/shop" class="mt-3 inline-block text-sm font-medium text-accent">
          Clear all filters
        </RouterLink>
      </div>
    </div>
  </div>
</template>
