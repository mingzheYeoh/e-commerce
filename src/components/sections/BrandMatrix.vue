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
  <section id="brands" class="border-t border-border-hairline bg-void py-16 md:py-20">
    <div class="mx-auto mb-10 max-w-[1600px] px-4 md:px-8">
      <div class="flex items-end justify-between gap-6">
        <div>
          <h2 class="text-2xl font-bold md:text-4xl">Shop by brand</h2>
          <p class="mt-2 text-sm text-text-secondary md:text-base">
            {{ brands.length }} authorised partners, one checkout and one returns policy.
          </p>
        </div>
        <a
          href="#drops"
          class="hidden shrink-0 items-center gap-1.5 text-sm font-medium text-accent transition-colors hover:text-accent-hover md:flex"
        >
          View all products
          <ArrowRight class="h-4 w-4" aria-hidden="true" />
        </a>
      </div>
    </div>

    <!-- Brand marquee -->
    <div class="group/marquee relative overflow-hidden py-2" @mouseleave="hovered = null">
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
        <li v-for="(brand, index) in track" :key="`${brand.id}-${index}`" class="shrink-0 px-2">
          <button
            type="button"
            class="flex items-center gap-3 rounded-card border px-6 py-4 transition-colors md:px-8"
            :class="
              hovered?.id === brand.id
                ? 'border-border-strong bg-surface-1'
                : 'border-transparent hover:bg-surface-1'
            "
            :aria-label="`Preview ${brand.name}, ${brand.productCount} products`"
            @mouseenter="hovered = brand"
            @focus="hovered = brand"
          >
            <span
              class="font-display text-xl font-bold transition-colors duration-300 md:text-2xl"
              :class="hovered?.id === brand.id ? 'text-text-primary' : 'text-text-secondary'"
            >
              {{ brand.name }}
            </span>
            <span class="nums rounded bg-surface-2 px-1.5 py-0.5 text-xs text-text-muted">
              {{ brand.productCount }}
            </span>
          </button>
        </li>
      </ul>
    </div>

    <!-- Preview panel -->
    <div class="mx-auto mt-8 max-w-[1600px] px-4 md:px-8">
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
          class="card flex flex-col gap-5 overflow-hidden md:flex-row md:items-center"
        >
          <div class="relative h-44 w-full shrink-0 overflow-hidden md:h-36 md:w-64">
            <img
              :src="hovered.previewImage"
              :alt="hovered.name"
              width="256"
              height="144"
              class="h-full w-full object-cover"
            />
            <div
              class="absolute inset-0"
              :style="{ boxShadow: `inset 0 0 50px -12px ${hovered.accent}55` }"
              aria-hidden="true"
            />
          </div>

          <div class="flex-1 px-5 pb-5 md:px-0 md:pb-0">
            <p class="text-xs font-medium" :style="{ color: hovered.accent }">Authorised partner</p>
            <p class="font-display text-xl font-bold md:text-2xl">{{ hovered.name }}</p>
            <p class="mt-1 text-sm text-text-secondary">{{ hovered.tagline }}</p>
          </div>

          <a href="#drops" class="btn-secondary mx-5 mb-5 text-center md:mx-6 md:mb-0">
            Shop {{ hovered.productCount }} products
          </a>
        </article>

        <p v-else class="py-6 text-center text-sm text-text-secondary">
          Hover a brand to see what we carry.
        </p>
      </Transition>
    </div>
  </section>
</template>
