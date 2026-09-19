<script setup lang="ts">
import { ArrowRight } from 'lucide-vue-next'
import { RouterLink } from 'vue-router'
import { brands } from '@/data/brands'

// The track renders the list twice and slides exactly -50%, so the seam lands
// on an identical frame and the loop is invisible.
const track = [...brands, ...brands]
</script>

<template>
  <section class="border-t border-border-hairline bg-void py-14 md:py-16">
    <div class="mx-auto mb-8 max-w-[1600px] px-4 md:px-8">
      <div class="flex items-end justify-between gap-6">
        <div>
          <h2 class="text-2xl font-bold md:text-3xl">Shop by brand</h2>
          <p class="mt-2 text-sm text-text-secondary">
            {{ brands.length }} authorised partners, one checkout and one returns policy.
          </p>
        </div>
        <RouterLink
          to="/shop"
          class="hidden shrink-0 items-center gap-1.5 text-sm font-medium text-accent transition-colors hover:text-accent-hover md:flex"
        >
          View all products
          <ArrowRight class="h-4 w-4" aria-hidden="true" />
        </RouterLink>
      </div>
    </div>

    <!-- Slim logo strip. Each brand is a link into a filtered shop view, which
         is the only job this section needs to do on a homepage. -->
    <div class="group/marquee relative overflow-hidden">
      <div
        class="pointer-events-none absolute inset-y-0 left-0 z-20 w-12 bg-gradient-to-r from-void to-transparent md:w-32"
        aria-hidden="true"
      />
      <div
        class="pointer-events-none absolute inset-y-0 right-0 z-20 w-12 bg-gradient-to-l from-void to-transparent md:w-32"
        aria-hidden="true"
      />

      <ul
        class="flex w-max animate-marquee items-center group-hover/marquee:[animation-play-state:paused]"
      >
        <li v-for="(brand, index) in track" :key="`${brand.id}-${index}`" class="shrink-0 px-1.5">
          <RouterLink
            :to="{ path: '/shop', query: { brand: brand.id } }"
            class="flex items-center gap-2.5 rounded-card border border-transparent px-5 py-3 transition-colors hover:border-border-hairline hover:bg-surface-1 md:px-7"
          >
            <span
              class="font-display text-lg font-bold text-text-secondary transition-colors hover:text-text-primary md:text-xl"
            >
              {{ brand.name }}
            </span>
            <span class="nums rounded bg-surface-2 px-1.5 py-0.5 text-xs text-text-muted">
              {{ brand.productCount }}
            </span>
          </RouterLink>
        </li>
      </ul>
    </div>
  </section>
</template>
