<script setup lang="ts">
import { ref } from 'vue'
import { ArrowRight } from 'lucide-vue-next'
import { brands } from '@/data/brands'
import type { Brand } from '@/types'

const hovered = ref<Brand | null>(null)

// The track renders the list twice and slides exactly -50%, so the seam lands
// on an identical frame and the loop is invisible.
const track = [...brands, ...brands]
</script>

<template>
  <section id="brands" class="relative border-y border-border-hairline bg-void py-16 md:py-24">
    <!-- Section header -->
    <div class="mx-auto mb-10 max-w-[1800px] px-4 md:mb-14 md:px-8">
      <div class="flex items-end justify-between gap-6 border-b border-border-hairline pb-5">
        <div>
          <p class="mono-label mb-2 text-accent-cyan">[01_BRANDS]</p>
          <h2
            class="font-display text-3xl font-extrabold uppercase leading-none tracking-tighter md:text-5xl lg:text-6xl"
          >
            Collective<br class="md:hidden" />
            <span class="text-text-muted"> Matrix</span>
          </h2>
        </div>
        <p class="mono-label hidden max-w-xs text-right leading-relaxed md:block">
          SIX CERTIFIED PARTNERS<br />
          ONE DISPATCH CHANNEL
        </p>
      </div>
    </div>

    <!-- Marquee -->
    <div
      class="group/marquee relative overflow-hidden"
      @mouseleave="hovered = null"
    >
      <!-- Edge fades so logos dissolve into the void rather than being cut -->
      <div
        class="pointer-events-none absolute inset-y-0 left-0 z-20 w-16 bg-gradient-to-r from-void to-transparent md:w-40"
        aria-hidden="true"
      />
      <div
        class="pointer-events-none absolute inset-y-0 right-0 z-20 w-16 bg-gradient-to-l from-void to-transparent md:w-40"
        aria-hidden="true"
      />

      <ul
        class="flex w-max animate-marquee items-center group-hover/marquee:[animation-play-state:paused]"
      >
        <li v-for="(brand, index) in track" :key="`${brand.id}-${index}`" class="shrink-0">
          <button
            type="button"
            class="flex items-center gap-4 border-r border-border-hairline px-6 py-6 transition-colors md:px-12"
            :aria-label="`Preview ${brand.name}, ${brand.productCount} items`"
            @mouseenter="hovered = brand"
            @focus="hovered = brand"
          >
            <span
              class="font-display text-xl font-extrabold uppercase tracking-tighter transition-colors duration-300 md:text-3xl"
              :style="{ color: hovered?.id === brand.id ? brand.accent : undefined }"
              :class="hovered?.id === brand.id ? '' : 'text-text-secondary/70'"
            >
              {{ brand.name }}
            </span>
            <span class="mono-label shrink-0">{{ brand.productCount }}</span>
          </button>
        </li>
      </ul>
    </div>

    <!-- Hover portal: swaps in the brand's own photography -->
    <div class="mx-auto mt-10 max-w-[1800px] px-4 md:px-8">
      <Transition
        mode="out-in"
        enter-from-class="opacity-0 translate-y-2"
        leave-to-class="opacity-0"
        enter-active-class="transition duration-300"
        leave-active-class="transition duration-150"
      >
        <article
          v-if="hovered"
          :key="hovered.id"
          class="relative flex flex-col gap-5 overflow-hidden border border-border-hairline bg-surface-1 md:flex-row md:items-center"
        >
          <div class="relative h-44 w-full shrink-0 overflow-hidden md:h-40 md:w-72">
            <img
              :src="hovered.previewImage"
              :alt="hovered.name"
              width="288"
              height="160"
              class="h-full w-full object-cover"
            />
            <div class="absolute inset-0 bg-scanlines bg-scan-4 opacity-50" aria-hidden="true" />
            <div
              class="absolute inset-0"
              :style="{ boxShadow: `inset 0 0 60px -10px ${hovered.accent}66` }"
              aria-hidden="true"
            />
          </div>

          <div class="flex-1 px-5 pb-5 md:px-0 md:pb-0">
            <p class="mono-label" :style="{ color: hovered.accent }">CERTIFIED_PARTNER</p>
            <p class="font-display text-2xl font-extrabold uppercase tracking-tighter md:text-3xl">
              {{ hovered.name }}
            </p>
            <p class="mt-1 text-sm text-text-secondary">{{ hovered.tagline }}</p>
          </div>

          <a
            href="#drops"
            class="mx-5 mb-5 flex items-center justify-center gap-2 border border-border-hairline px-5 py-3 font-mono text-[11px] tracking-[0.14em] text-text-secondary transition-colors hover:border-accent-cyan/60 hover:text-accent-cyan md:mx-8 md:mb-0"
          >
            EXPLORE INVENTORY ({{ hovered.productCount }})
            <ArrowRight class="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </article>

        <p v-else class="mono-label py-6 text-center">
          HOVER A PARTNER TO OPEN ITS PREVIEW PORTAL
        </p>
      </Transition>
    </div>
  </section>
</template>
