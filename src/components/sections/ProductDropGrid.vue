<script setup lang="ts">
import { computed } from 'vue'
import ProductCard from '@/components/commerce/ProductCard.vue'
import { useCatalogStore, type Filter } from '@/stores/catalog'

const catalog = useCatalogStore()

const filters: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All products' },
  { id: 'inStock', label: 'In stock' },
  { id: 'audio', label: 'Audio' },
  { id: 'peripherals', label: 'Keyboards & mice' },
  { id: 'imaging', label: 'Cameras & drones' },
  { id: 'computing', label: 'Laptops & wearables' },
]

const count = computed(() => catalog.visible.length)
</script>

<template>
  <section id="drops" class="border-t border-border-hairline bg-void py-16 md:py-24">
    <div class="mx-auto max-w-[1600px] px-4 md:px-8">
      <div class="mb-8 flex items-end justify-between gap-6">
        <div>
          <h2 class="text-2xl font-bold md:text-4xl">All products</h2>
          <p class="mt-2 text-sm text-text-secondary md:text-base">
            <span class="nums">{{ count }}</span> products in stock, ready to ship today.
          </p>
        </div>

      </div>
    </div>

    <!-- Filter rail. Sticks under the 64px nav so the controls stay reachable
         while scanning a long grid. -->
    <div
      class="sticky top-16 z-30 border-y border-border-hairline bg-void/90 backdrop-blur-md"
    >
      <div
        class="mx-auto flex max-w-[1600px] items-center gap-2 overflow-x-auto px-4 py-3 md:px-8"
      >
        <button
          v-for="filter in filters"
          :key="filter.id"
          type="button"
          class="shrink-0 rounded-full border px-4 py-1.5 text-sm font-medium transition-colors"
          :class="
            catalog.activeFilter === filter.id
              ? 'border-accent bg-accent text-white'
              : 'border-border-hairline text-text-secondary hover:border-border-strong hover:text-text-primary'
          "
          :aria-pressed="catalog.activeFilter === filter.id"
          @click="catalog.setFilter(filter.id)"
        >
          {{ filter.label }}
        </button>

        <span class="mx-1 hidden h-4 w-px shrink-0 bg-border-hairline md:block" aria-hidden="true" />

        <button
          type="button"
          class="shrink-0 rounded-full border px-4 py-1.5 text-sm font-medium transition-colors"
          :class="
            catalog.sort === 'priceDesc'
              ? 'border-accent bg-accent text-white'
              : 'border-border-hairline text-text-secondary hover:border-border-strong hover:text-text-primary'
          "
          :aria-pressed="catalog.sort === 'priceDesc'"
          @click="catalog.setSort(catalog.sort === 'priceDesc' ? 'default' : 'priceDesc')"
        >
          Price: high to low
        </button>
      </div>
    </div>

    <div class="mx-auto max-w-[1600px] px-4 pt-8 md:px-8">
      <TransitionGroup
        tag="div"
        class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        enter-from-class="opacity-0 translate-y-3"
        leave-to-class="opacity-0"
        enter-active-class="transition duration-300"
        leave-active-class="absolute transition duration-200"
        move-class="transition duration-300"
      >
        <ProductCard
          v-for="product in catalog.visible"
          :key="product.id"
          :product="product"
        />
      </TransitionGroup>

      <p
        v-if="!count"
        class="py-20 text-center text-sm text-text-secondary"
      >
        No products match these filters.
      </p>
    </div>
  </section>
</template>
