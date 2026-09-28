<script setup lang="ts">
import { ArrowRight } from 'lucide-vue-next'
import { RouterLink } from 'vue-router'
import { brands } from '@/data/brands'
import { marqueeTrack, splitRows } from '@/lib/marquee'
import { vReveal } from '@/lib/reveal'

/**
 * Two rows of brands drifting in opposite directions. Each row is the brands
 * once for real, then repeats marked as copies (see marqueeTrack): a screen
 * reader hears every brand once and Tab visits each link once, not four times.
 *
 * Fourteen per half keeps a half wider than a 2560px screen, so the loop never
 * shows its seam. Under reduced motion the copies are hidden and the tracks
 * wrap into a still grid (main.css).
 */
const rows = splitRows(brands).map((row) => marqueeTrack(row, 14))
</script>

<template>
  <section class="border-t border-border-hairline bg-void py-14 md:py-16">
    <div class="mx-auto mb-8 max-w-[1600px] px-4 md:px-8">
      <div v-reveal class="flex items-end justify-between gap-6">
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

    <!-- Each brand is a link into a filtered shop view, which is the only job
         this section needs to do on a homepage. Hovering or focusing anywhere
         in it stops both rows, so nothing slides out from under the pointer. -->
    <div class="marquee relative overflow-hidden">
      <div
        class="marquee-fade pointer-events-none absolute inset-y-0 left-0 z-20 w-12 bg-gradient-to-r from-void to-transparent md:w-40"
        aria-hidden="true"
      />
      <div
        class="marquee-fade pointer-events-none absolute inset-y-0 right-0 z-20 w-12 bg-gradient-to-l from-void to-transparent md:w-40"
        aria-hidden="true"
      />

      <!-- The reveal animates these wrappers, never the tracks: both use `animation`. -->
      <div v-reveal class="flex flex-col gap-3">
        <div v-for="(track, r) in rows" :key="r">
          <ul
            class="marquee-track flex w-max animate-marquee items-center gap-y-3"
            :data-reverse="r === 1 || undefined"
          >
            <li
              v-for="entry in track"
              :key="entry.key"
              class="shrink-0 px-1.5"
              :data-copy="entry.copy || undefined"
              :aria-hidden="entry.copy || undefined"
            >
              <RouterLink
                :to="{ path: '/shop', query: { brand: entry.item.id } }"
                :tabindex="entry.copy ? -1 : undefined"
                class="group flex items-center gap-2.5 rounded-card border border-border-hairline bg-surface-1/60 px-5 py-3 transition-colors hover:border-border-strong hover:bg-surface-1 md:px-7"
              >
                <span
                  class="font-display text-lg font-bold text-text-secondary transition-colors group-hover:text-text-primary md:text-xl"
                >
                  {{ entry.item.name }}
                </span>
                <span class="nums rounded bg-surface-2 px-1.5 py-0.5 text-xs text-text-muted">
                  {{ entry.item.productCount }}
                </span>
              </RouterLink>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </section>
</template>
