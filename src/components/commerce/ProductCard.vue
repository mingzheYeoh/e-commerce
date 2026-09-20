<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { Check, Star, Scale } from 'lucide-vue-next'
import StockBadge from './StockBadge.vue'
import PriceTag from './PriceTag.vue'
import { useCartStore } from '@/stores/cart'
import { useCompareStore } from '@/stores/compare'
import { useTilt } from '@/composables/useTilt'
import { brandName } from '@/data/brands'
import type { Product } from '@/types'

const props = defineProps<{ product: Product }>()

const cart = useCartStore()
const compare = useCompareStore()
const added = ref(false)

/**
 * The hover image is gallery[1], which the pipeline does not always find — and
 * a missing asset does not 404 here, it serves the SPA shell, so the browser
 * gets HTML where it wanted a picture. Hiding it on error leaves the hero
 * showing, which is what a card with one photograph should look like.
 */
const hoverBroken = ref(false)

const { transform, glare, onMove, onLeave } = useTilt()

const selected = computed(() => compare.has(props.product.id))
/**
 * Greyed out when the comparison already holds another category, or is full.
 * The store refuses either case anyway; this is so the shopper sees it coming
 * rather than clicking a control that silently does nothing.
 */
const blocked = computed(() => !compare.canAdd(props.product))
const reason = computed(() => {
  if (!blocked.value) return `Compare ${props.product.title}`
  return compare.full
    ? `Comparison is full — remove one to add ${props.product.title}`
    : `Already comparing ${compare.category === 'computing' ? 'laptops' : compare.category}`
})
let resetTimer: number | undefined

function addToCart() {
  if (!props.product.inStock) return
  cart.add(props.product)

  // Confirm in place. The header counter also pulses, but the feedback has to
  // land where the click happened or the button reads as dead.
  added.value = true
  window.clearTimeout(resetTimer)
  resetTimer = window.setTimeout(() => (added.value = false), 900)
}
</script>

<template>
  <RouterLink
    :to="`/product/${product.id}`"
    class="card tilt group flex flex-col overflow-hidden transition-colors hover:border-border-strong"
    :style="transform ? { transform } : undefined"
    @pointermove="onMove"
    @pointerleave="onLeave"
  >
    <!--
      A specular highlight that tracks the pointer. The rotation alone reads as
      a flat card being turned; a moving light is what makes it read as a
      surface catching one. Non-interactive and hidden from assistive tech: it
      carries no information a screen reader could use.
    -->
    <span
      v-if="glare"
      aria-hidden="true"
      class="pointer-events-none absolute inset-0 z-10 rounded-card opacity-60"
      :style="{
        background: `radial-gradient(420px circle at ${glare.x}% ${glare.y}%, rgb(255 255 255 / 7%), transparent 60%)`,
      }"
    />
    <div class="relative aspect-[4/3] overflow-hidden bg-surface-2">
      <img
        :src="product.media.heroImage"
        :alt="product.title"
        width="600"
        height="450"
        loading="lazy"
        class="absolute inset-0 h-full w-full object-cover transition-opacity duration-500 group-hover:opacity-0"
      />
      <img
        v-if="product.media.hoverImage && !hoverBroken"
        :src="product.media.hoverImage"
        @error="hoverBroken = true"
        alt=""
        aria-hidden="true"
        width="600"
        height="450"
        loading="lazy"
        class="absolute inset-0 h-full w-full scale-105 object-cover opacity-0 transition-all duration-500 group-hover:scale-100 group-hover:opacity-100"
      />

      <div class="absolute left-3 top-3">
        <StockBadge :product="product" />
      </div>

      <!--
        The card's root element is a RouterLink, so this has to stop the click
        from reaching it. Without .prevent, ticking the box navigates away to
        the product page and the selection is never seen.
      -->
      <button
        type="button"
        class="absolute right-3 top-3 flex items-center gap-1.5 rounded border px-2 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40"
        :class="
          selected
            ? 'border-accent bg-accent text-white'
            : 'border-border-hairline bg-void/80 text-text-secondary backdrop-blur hover:text-text-primary'
        "
        :disabled="blocked"
        :aria-pressed="selected"
        :title="reason"
        @click.stop.prevent="compare.toggle(product)"
      >
        <Scale class="h-3 w-3" aria-hidden="true" />
        <span>{{ selected ? 'Comparing' : 'Compare' }}</span>
      </button>

      <div v-if="product.colorways.length > 1" class="absolute bottom-3 left-3 flex gap-1.5">
        <span
          v-for="way in product.colorways"
          :key="way.name"
          class="h-3.5 w-3.5 rounded-full border border-white/30"
          :style="{ backgroundColor: way.hex }"
          :title="way.name"
        />
        <span class="sr-only">
          Available in {{ product.colorways.map((c) => c.name).join(', ') }}
        </span>
      </div>
    </div>

    <div class="flex flex-1 flex-col gap-3 p-4">
      <div class="flex-1">
        <p class="text-xs text-text-secondary">{{ brandName(product.brand) }}</p>
        <h3 class="mt-0.5 text-sm font-semibold leading-snug">{{ product.title }}</h3>
        <p class="mt-1.5 text-xs leading-relaxed text-text-secondary">
          {{ product.specsSummary.join(' · ') }}
        </p>
      </div>

      <div class="flex items-center gap-1.5 text-xs text-text-secondary">
        <Star class="h-3.5 w-3.5 fill-accent-amber text-accent-amber" aria-hidden="true" />
        <span class="nums font-medium text-text-primary">{{ product.rating.toFixed(1) }}</span>
        <span class="nums">({{ product.reviewCount.toLocaleString('en-US') }})</span>
      </div>

      <div class="flex items-center justify-between gap-3 border-t border-border-hairline pt-3">
        <PriceTag :cents="Math.round(product.price * 100)" />

        <button
          type="button"
          class="rounded px-3.5 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-text-muted"
          :class="
            added ? 'bg-accent-green/15 text-accent-green' : 'bg-accent text-white hover:bg-accent-hover'
          "
          :disabled="!product.inStock"
          :aria-label="product.inStock ? `Add ${product.title} to cart` : `${product.title} is sold out`"
          @click.stop.prevent="addToCart"
        >
          <span v-if="!product.inStock">Sold out</span>
          <span v-else-if="added" class="flex items-center gap-1.5">
            Added
            <Check class="h-3.5 w-3.5" aria-hidden="true" />
          </span>
          <span v-else>Add to cart</span>
        </button>
      </div>
    </div>
  </RouterLink>
</template>
