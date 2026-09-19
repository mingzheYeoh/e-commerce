<script setup lang="ts">
import { computed } from 'vue'
import ProductCard from '@/components/commerce/ProductCard.vue'
import { useCatalogStore, type Filter } from '@/stores/catalog'

const catalog = useCatalogStore()

const filters: { id: Filter; label: string }[] = [
  { id: 'all', label: 'ALL ITEMS' },
  { id: 'inStock', label: 'IN STOCK ONLY' },
  { id: 'audio', label: 'ACOUSTICS' },
  { id: 'peripherals', label: 'PERIPHERALS' },
  { id: 'imaging', label: 'IMAGING' },
  { id: 'computing', label: 'COMPUTING' },
]

const count = computed(() => catalog.visible.length)
</script>

<template>
  <section id="drops" class="border-t border-border-hairline bg-void py-16 md:py-24">
    <div class="mx-auto max-w-[1800px] px-4 md:px-8">
      <div class="mb-8 flex items-end justify-between gap-6 border-b border-border-hairline pb-5">
        <div>
          <p class="mono-label mb-2 text-accent-cyan">[04_DROPS]</p>
          <h2
            class="font-display text-3xl font-extrabold uppercase leading-none tracking-tighter md:text-5xl lg:text-6xl"
          >
            Live<span class="text-text-muted"> Inventory</span>
          </h2>
        </div>
        <p class="mono-label hidden shrink-0 text-right md:block">
          {{ count }} SKU(S) MATCHING<br />
          REALTIME STOCK FEED
        </p>
      </div>
    </div>

    <!-- Filter rail. Sticks under the 64px nav so the controls stay reachable
         while scanning a long grid. -->
    <div
      class="sticky top-16 z-30 border-y border-border-hairline bg-void/90 backdrop-blur-md"
    >
      <div
        class="mx-auto flex max-w-[1800px] items-center gap-2 overflow-x-auto px-4 py-3 md:px-8"
      >
        <button
          v-for="filter in filters"
          :key="filter.id"
          type="button"
          class="shrink-0 border px-3 py-1.5 font-mono text-[10px] tracking-[0.12em] transition-colors md:text-[11px]"
          :class="
            catalog.activeFilter === filter.id
              ? 'border-accent-cyan bg-accent-cyan/15 text-accent-cyan'
              : 'border-border-hairline text-text-secondary hover:border-text-secondary/50 hover:text-text-primary'
          "
          :aria-pressed="catalog.activeFilter === filter.id"
          @click="catalog.setFilter(filter.id)"
        >
          [{{ filter.label }}]
        </button>

        <span class="mx-1 hidden h-4 w-px shrink-0 bg-border-hairline md:block" aria-hidden="true" />

        <button
          type="button"
          class="shrink-0 border px-3 py-1.5 font-mono text-[10px] tracking-[0.12em] transition-colors md:text-[11px]"
          :class="
            catalog.sort === 'priceDesc'
              ? 'border-accent-cyan bg-accent-cyan/15 text-accent-cyan'
              : 'border-border-hairline text-text-secondary hover:border-text-secondary/50 hover:text-text-primary'
          "
          :aria-pressed="catalog.sort === 'priceDesc'"
          @click="catalog.setSort(catalog.sort === 'priceDesc' ? 'default' : 'priceDesc')"
        >
          [PRICE: HIGH → LOW]
        </button>
      </div>
    </div>

    <div class="mx-auto max-w-[1800px] px-4 pt-8 md:px-8">
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
        class="py-20 text-center font-mono text-xs tracking-[0.14em] text-text-muted"
      >
        NO_UNITS_MATCH_FILTER
      </p>
    </div>
  </section>
</template>
