<script setup lang="ts">
import { computed } from 'vue'
import { ArrowUpRight } from 'lucide-vue-next'
import { RouterLink } from 'vue-router'
import { categories } from '@/data/categories'
import { useCurrency } from '@/composables/useCurrency'
import { useTilt } from '@/composables/useTilt'
import { bentoLayout } from '@/lib/bento'
import { vReveal } from '@/lib/reveal'

const { formatPrice } = useCurrency()

// Light only, no lean: a tile half the width of the page tilting reads as the
// page tilting. One handler pair serves every tile — it writes to whichever
// element the event came from.
const { onMove, onLeave } = useTilt(0)

/**
 * Bento placement, from the order of the categories rather than a size written
 * against each one: the first is the hero, the rest fill around it, and a
 * sixth department cannot open a hole in the grid. The four-column bento is
 * for lg and up; a tablet gets two columns with the hero across both, since a
 * quarter of 768px is too narrow for a title and a blurb. Literal class names
 * so Tailwind can see them.
 */
const COLS = { 1: 'lg:col-span-1', 2: 'md:col-span-2', 4: 'md:col-span-2 lg:col-span-4' } as const
const ROWS = { 1: 'lg:row-span-1', 2: 'lg:row-span-2' } as const

const tiles = computed(() => {
  const layout = bentoLayout(categories.length)
  return categories.map((category, i) => ({
    category,
    hero: layout[i].rows === 2,
    classes: [COLS[layout[i].cols], ROWS[layout[i].rows]],
  }))
})
</script>

<template>
  <section id="categories" class="bg-void py-16 md:py-24">
    <div class="mx-auto max-w-[1800px] px-4 md:px-8">
      <div v-reveal class="mb-8 flex items-end justify-between gap-6">
        <div>
          <h2 class="text-2xl font-bold md:text-4xl">Shop by category</h2>
          <p class="mt-2 text-sm text-text-secondary md:text-base">
            <!--
              Counted, not written down. The copy said "Four departments" for as
              long as there were five, because adding the phones category did
              not look like a copy change.
            -->
            {{ categories.length }} departments, everything in stock today.
          </p>
        </div>
      </div>

      <div
        v-reveal
        class="grid grid-cols-1 gap-3 md:grid-cols-2 lg:auto-rows-[minmax(250px,auto)] lg:grid-flow-row-dense lg:grid-cols-4"
      >
        <RouterLink
          v-for="{ category, hero, classes } in tiles"
          :key="category.id"
          :to="{ path: '/shop', query: { category: category.id } }"
          class="spotlight beam group relative overflow-hidden rounded-card border border-border-hairline bg-surface-1 text-left transition-colors hover:border-border-strong"
          :class="[classes, hero ? 'min-h-[340px]' : 'min-h-[220px]']"
          @pointermove="onMove"
          @pointerleave="onLeave"
        >
          <!-- A slow push-in on hover; flattened by the reduced-motion kill switch -->
          <img
            :src="category.image"
            :alt="category.label"
            width="800"
            height="520"
            loading="lazy"
            class="absolute inset-0 h-full w-full scale-[1.02] object-cover opacity-40 transition-[transform,opacity] duration-700 ease-out group-hover:scale-[1.07] group-hover:opacity-60"
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
                class="h-5 w-5 shrink-0 text-text-muted transition-all group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-accent"
                aria-hidden="true"
              />
            </div>

            <div>
              <h3
                class="font-bold leading-tight"
                :class="hero ? 'text-2xl md:text-4xl' : 'text-lg md:text-xl'"
              >
                {{ category.label }}
              </h3>
              <p
                class="mt-2 max-w-md text-sm text-text-secondary"
                :class="!hero && 'md:line-clamp-2'"
              >
                {{ category.blurb }}
              </p>
              <span
                v-if="category.fromPrice"
                class="mt-3 inline-block text-sm font-medium text-accent"
              >
                From {{ formatPrice(category.fromPrice) }}
              </span>
            </div>
          </div>
        </RouterLink>
      </div>
    </div>
  </section>
</template>
