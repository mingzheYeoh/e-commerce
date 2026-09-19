<script setup lang="ts">
import { ref } from 'vue'
import { Plus, Check, Star } from 'lucide-vue-next'
import StockBadge from './StockBadge.vue'
import PriceTag from './PriceTag.vue'
import { useCartStore } from '@/stores/cart'
import type { Product } from '@/types'

const props = defineProps<{ product: Product }>()

const cart = useCartStore()
const added = ref(false)
let resetTimer: number | undefined

function quickAdd() {
  if (!props.product.inStock) return
  cart.add(props.product)

  // Confirm in place. The nav counter also pulses, but the feedback has to land
  // where the click happened or it reads as a dead button.
  added.value = true
  window.clearTimeout(resetTimer)
  resetTimer = window.setTimeout(() => (added.value = false), 900)
}
</script>

<template>
  <article
    class="group relative flex flex-col border border-border-hairline bg-surface-1 transition-colors hover:border-accent-cyan/40"
  >
    <!-- Media -->
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
        v-if="product.media.hoverImage"
        :src="product.media.hoverImage"
        alt=""
        aria-hidden="true"
        width="600"
        height="450"
        loading="lazy"
        class="absolute inset-0 h-full w-full scale-105 object-cover opacity-0 transition-all duration-500 group-hover:scale-100 group-hover:opacity-100"
      />

      <div
        class="pointer-events-none absolute inset-0 bg-scanlines bg-scan-4 opacity-25"
        aria-hidden="true"
      />
      <div
        class="pointer-events-none absolute inset-0 bg-gradient-to-t from-surface-1 via-transparent to-transparent"
        aria-hidden="true"
      />

      <div class="absolute left-3 top-3">
        <StockBadge :product="product" />
      </div>

      <span
        class="absolute right-3 top-3 border border-border-hairline bg-void/70 px-2 py-1 font-mono text-[10px] tracking-[0.12em] text-text-secondary backdrop-blur-sm"
      >
        {{ product.brand.replace('_', ' ') }}
      </span>

      <!-- Colorways: a physical cue that the product ships in variants -->
      <div v-if="product.colorways.length > 1" class="absolute bottom-3 left-3 flex gap-1.5">
        <span
          v-for="way in product.colorways"
          :key="way.name"
          class="h-3 w-3 border border-white/25"
          :style="{ backgroundColor: way.hex }"
          :title="way.name"
        />
        <span class="sr-only">
          Available in {{ product.colorways.map((c) => c.name).join(', ') }}
        </span>
      </div>
    </div>

    <!-- Meta -->
    <div class="flex flex-1 flex-col gap-3 p-4">
      <div class="flex-1">
        <h3 class="text-sm font-semibold leading-snug tracking-tight text-text-primary">
          {{ product.title }}
        </h3>
        <p class="mono-label mt-1.5 leading-relaxed">
          {{ product.specsSummary.join(' // ') }}
        </p>
      </div>

      <div class="flex items-center gap-1.5 font-mono text-[11px] text-text-secondary">
        <Star class="h-3 w-3 fill-accent-cyan text-accent-cyan" aria-hidden="true" />
        <span class="nums">{{ product.rating.toFixed(1) }}</span>
        <span class="text-text-muted">({{ product.reviewCount }})</span>
        <span class="ml-auto font-mono text-[10px] text-text-muted">{{ product.sku }}</span>
      </div>

      <div class="flex items-center justify-between gap-3 border-t border-border-hairline pt-3">
        <PriceTag :cents="Math.round(product.price * 100)" />

        <button
          type="button"
          class="flex items-center gap-1.5 border px-3 py-2 font-mono text-[10px] font-bold tracking-[0.12em] transition-all disabled:cursor-not-allowed disabled:border-border-hairline disabled:bg-transparent disabled:text-text-muted"
          :class="
            added
              ? 'border-accent-neon bg-accent-neon/15 text-accent-neon'
              : 'border-text-primary bg-text-primary text-void hover:border-accent-cyan hover:bg-accent-cyan'
          "
          :disabled="!product.inStock"
          :aria-label="
            product.inStock ? `Add ${product.title} to bag` : `${product.title} is sold out`
          "
          @click="quickAdd"
        >
          <template v-if="!product.inStock">SOLD OUT</template>
          <template v-else-if="added">
            ADDED
            <Check class="h-3 w-3" aria-hidden="true" />
          </template>
          <template v-else>
            ADD
            <Plus class="h-3 w-3" aria-hidden="true" />
          </template>
        </button>
      </div>
    </div>
  </article>
</template>
