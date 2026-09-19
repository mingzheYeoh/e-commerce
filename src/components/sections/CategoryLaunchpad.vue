<script setup lang="ts">
import { ArrowUpRight } from 'lucide-vue-next'
import { categories } from '@/data/categories'
import { useCatalogStore } from '@/stores/catalog'
import { useCurrency } from '@/composables/useCurrency'
import type { Category } from '@/types'

const catalog = useCatalogStore()
const { formatPrice } = useCurrency()

// Bento placement. Explicit per span so the asymmetry is deliberate rather than
// whatever auto-flow happens to produce.
const spanClass: Record<Category['span'], string> = {
  large: 'md:col-span-2 md:row-span-2 min-h-[320px] md:min-h-[520px]',
  square: 'md:col-span-2 md:row-span-1 min-h-[240px]',
  wide: 'md:col-span-4 md:row-span-1 min-h-[240px]',
}

function jumpToCategory(category: Category) {
  catalog.setFilter(category.id)
  document.getElementById('drops')?.scrollIntoView({ behavior: 'smooth' })
}
</script>

<template>
  <section id="categories" class="bg-void py-16 md:py-24">
    <div class="mx-auto max-w-[1800px] px-4 md:px-8">
      <div class="mb-8 flex items-end justify-between gap-6">
        <div>
          <h2 class="text-2xl font-bold md:text-4xl">Shop by category</h2>
          <p class="mt-2 text-sm text-text-secondary md:text-base">
            Four departments, {{ categories.length ? '' : '' }}everything in stock today.
          </p>
        </div>
        
      </div>

      <div class="grid grid-cols-1 gap-3 md:grid-cols-4">
        <button
          v-for="category in categories"
          :key="category.id"
          type="button"
          class="group relative overflow-hidden rounded-card border border-border-hairline bg-surface-1 text-left transition-colors hover:border-border-strong"
          :class="spanClass[category.span]"
          @click="jumpToCategory(category)"
        >
          <!-- Ken Burns drift: slow, single-direction, disabled for reduced motion -->
          <img
            :src="category.image"
            :alt="category.label"
            width="800"
            height="520"
            loading="lazy"
            class="absolute inset-0 h-full w-full scale-105 object-cover opacity-40 transition-all duration-[1200ms] ease-out group-hover:scale-110 group-hover:opacity-60"
          />
          <div
            class="absolute inset-0 bg-gradient-to-t from-void via-void/70 to-transparent"
            aria-hidden="true"
          />
          

          <div class="relative flex h-full flex-col justify-between p-5 md:p-6">
            <div class="flex items-start justify-between gap-3">
              <span
                class="rounded-full bg-black/60 px-2.5 py-1 text-xs font-medium text-accent-green backdrop-blur-sm"
              >
                {{ category.unitsInStock }} in stock
              </span>
              <ArrowUpRight
                class="h-5 w-5 shrink-0 text-text-muted transition-all group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-accent"
                aria-hidden="true"
              />
            </div>

            <div>
              <h3
                class="font-bold leading-tight"
                :class="category.span === 'large' ? 'text-xl md:text-3xl' : 'text-lg md:text-xl'"
              >
                {{ category.label }}
              </h3>
              <p class="mt-2 max-w-md text-sm text-text-secondary">{{ category.blurb }}</p>
              <span
                class="mt-3 inline-block text-sm font-medium text-accent"
              >
                From {{ formatPrice(category.fromPrice) }}
              </span>
            </div>
          </div>
        </button>
      </div>
    </div>
  </section>
</template>
