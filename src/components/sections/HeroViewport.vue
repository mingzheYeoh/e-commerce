<script setup lang="ts">
import { computed } from 'vue'
import { ArrowDown, Truck, RotateCcw, ShieldCheck } from 'lucide-vue-next'
import VideoBackdrop from '@/components/fx/VideoBackdrop.vue'
// The curated pick is named by the build-time file; what it costs and how many
// are left come from the live catalogue, like everywhere else.
import { featuredDrop } from '@/data/products'
import { catalogueStatus, findProduct } from '@/stores/catalog'
import { brandName } from '@/data/brands'
import { useCartStore } from '@/stores/cart'
import { useCurrency } from '@/composables/useCurrency'

const cart = useCartStore()
const { format } = useCurrency()

/** Hidden once the live catalogue says the pick is no longer published. */
const drop = computed(
  () => findProduct(featuredDrop.id) ?? (catalogueStatus.value === 'live' ? undefined : featuredDrop),
)

const assurances = [
  { icon: Truck, text: 'Free standard delivery over $75' },
  { icon: RotateCcw, text: '30-day returns' },
  { icon: ShieldCheck, text: '2-year warranty' },
]
</script>

<template>
  <section
    id="top"
    class="relative flex min-h-[640px] w-full flex-col justify-between overflow-hidden bg-void px-4 pb-8 pt-24 md:h-screen md:px-8 md:pb-12"
  >
    <VideoBackdrop src="/media/video/hero-grid.mp4" poster="/media/video/hero-grid-poster.webp" />

    <!-- Assurance strip: the three things a shopper checks before anything else -->
    <ul
      class="relative z-10 flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-border-hairline pb-4 text-xs text-text-secondary"
    >
      <li v-for="item in assurances" :key="item.text" class="flex items-center gap-2">
        <component :is="item.icon" class="h-3.5 w-3.5 text-accent" aria-hidden="true" />
        {{ item.text }}
      </li>
    </ul>

    <!-- Headline -->
    <div class="relative z-10 my-12 max-w-3xl md:my-auto">
      <p class="mb-4 text-sm font-medium text-accent">New season · 2026 range</p>

      <h1
        class="text-4xl font-extrabold leading-[1.05] text-text-primary sm:text-5xl lg:text-6xl xl:text-7xl"
      >
        Premium electronics,<br />
        <span class="text-text-secondary">from the brands you trust.</span>
      </h1>

      <p class="mt-6 max-w-xl text-base leading-relaxed text-text-secondary md:text-lg">
        Apple, Samsung, Sony, Bose, DJI and more — headphones, cameras, drones, keyboards and
        laptops, shipped from one place.
      </p>

      <div class="mt-8 flex flex-wrap gap-3">
        <a href="#drops" class="btn-primary">Shop all products</a>
        <a href="#brands" class="btn-secondary">Browse brands</a>
      </div>
    </div>

    <!-- Featured product -->
    <div
      class="relative z-10 flex flex-col items-start justify-between gap-5 border-t border-border-hairline pt-5 md:flex-row md:items-end"
    >
      <article
        v-if="drop"
        class="card flex w-full items-center gap-4 p-3 transition-colors hover:border-border-strong md:w-auto"
      >
        <img
          :src="drop.media.thumb"
          :alt="drop.title"
          width="64"
          height="64"
          loading="eager"
          class="h-16 w-16 shrink-0 rounded border border-border-hairline bg-surface-2 object-cover"
        />

        <div class="min-w-0 flex-1">
          <p class="text-xs font-medium text-accent">Featured this week</p>
          <p class="truncate text-sm font-semibold">
            {{ brandName(drop.brand) }} {{ drop.title }}
          </p>
          <p class="nums text-sm text-text-secondary">
            {{ format(drop.priceMinor) }}
            <span class="text-text-muted">· {{ drop.stockCount }} in stock</span>
          </p>
        </div>

        <button
          type="button"
          class="btn-primary shrink-0 whitespace-nowrap"
          :aria-label="`Add ${drop.title} to cart`"
          @click="cart.add(drop)"
        >
          Add to cart
        </button>
      </article>

      <a
        href="#brands"
        class="flex shrink-0 items-center gap-2 text-sm text-text-secondary transition-colors hover:text-text-primary"
      >
        Scroll to explore
        <ArrowDown class="h-4 w-4" aria-hidden="true" />
      </a>
    </div>
  </section>
</template>
