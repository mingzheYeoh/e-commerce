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
      <div class="mb-10 flex items-end justify-between gap-6 border-b border-border-hairline pb-5">
        <div>
          <p class="mono-label mb-2 text-accent-cyan">[02_CATEGORIES]</p>
          <h2
            class="font-display text-3xl font-extrabold uppercase leading-none tracking-tighter md:text-5xl lg:text-6xl"
          >
            Category<span class="text-text-muted"> Launchpad</span>
          </h2>
        </div>
        <p class="mono-label hidden text-right md:block">SELECT_SEGMENT →</p>
      </div>

      <div class="grid grid-cols-1 gap-3 md:grid-cols-4">
        <button
          v-for="category in categories"
          :key="category.id"
          type="button"
          class="group relative overflow-hidden border border-border-hairline bg-surface-1 text-left transition-colors hover:border-accent-cyan/50"
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
          <div class="absolute inset-0 bg-scanlines bg-scan-4 opacity-30" aria-hidden="true" />

          <!-- Corner ticks: machined register marks -->
          <span
            class="absolute left-3 top-3 h-3 w-3 border-l border-t border-text-muted transition-colors group-hover:border-accent-cyan"
            aria-hidden="true"
          />
          <span
            class="absolute bottom-3 right-3 h-3 w-3 border-b border-r border-text-muted transition-colors group-hover:border-accent-cyan"
            aria-hidden="true"
          />

          <div class="relative flex h-full flex-col justify-between p-5 md:p-6">
            <div class="flex items-start justify-between gap-3">
              <span
                class="border border-border-hairline bg-void/60 px-2 py-1 font-mono text-[10px] tracking-[0.14em] text-accent-neon backdrop-blur-sm"
              >
                {{ category.unitsInStock }} UNITS IN STOCK
              </span>
              <ArrowUpRight
                class="h-5 w-5 shrink-0 text-text-muted transition-all group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-accent-cyan"
                aria-hidden="true"
              />
            </div>

            <div>
              <h3
                class="font-display font-extrabold uppercase leading-none tracking-tighter"
                :class="category.span === 'large' ? 'text-2xl md:text-4xl' : 'text-xl md:text-2xl'"
              >
                {{ category.label }}
              </h3>
              <p class="mt-2 max-w-md text-sm text-text-secondary">{{ category.blurb }}</p>
              <span
                class="mt-3 inline-block border border-accent-cyan/40 bg-accent-cyan/10 px-2.5 py-1 font-mono text-[10px] tracking-[0.14em] text-accent-cyan"
              >
                FROM {{ formatPrice(category.fromPrice) }}
              </span>
            </div>
          </div>
        </button>
      </div>
    </div>
  </section>
</template>
