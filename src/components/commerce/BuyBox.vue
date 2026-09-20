<script setup lang="ts">
import { computed, ref } from 'vue'
import { Check, Star, Truck, RotateCcw, ShieldCheck, Minus, Plus } from 'lucide-vue-next'
import PriceTag from './PriceTag.vue'
import { useCartStore } from '@/stores/cart'
import { brandName } from '@/data/brands'
import type { Product } from '@/types'

const props = defineProps<{ product: Product }>()

const cart = useCartStore()
const variant = ref(props.product.colorways[0])
const qty = ref(1)
const added = ref(false)

const stockLine = computed(() => {
  const p = props.product
  if (!p.inStock) return { text: 'Out of stock', class: 'text-text-muted' }
  if (p.stockCount <= 8)
    return { text: `Only ${p.stockCount} left in stock`, class: 'text-accent-amber' }
  return { text: 'In stock, ships today', class: 'text-accent-green' }
})

function addToCart() {
  if (!props.product.inStock) return
  cart.add(props.product, qty.value)
  added.value = true
  window.setTimeout(() => (added.value = false), 1200)
}

const assurances = [
  { icon: Truck, text: 'Free standard delivery over $75' },
  { icon: RotateCcw, text: '30-day free returns' },
  { icon: ShieldCheck, text: '2-year warranty included' },
]
</script>

<template>
  <div>
    <p class="text-sm text-text-secondary">{{ brandName(product.brand) }}</p>
    <h1 class="mt-1 text-3xl font-bold md:text-4xl">{{ product.title }}</h1>

    <div class="mt-3 flex items-center gap-2 text-sm">
      <Star class="h-4 w-4 fill-accent-amber text-accent-amber" aria-hidden="true" />
      <span class="nums font-medium">{{ product.rating.toFixed(1) }}</span>
      <span class="nums text-text-secondary">
        ({{ product.reviewCount.toLocaleString('en-US') }} reviews)
      </span>
    </div>

    <div class="mt-6">
      <PriceTag :cents="Math.round(product.price * 100)" size="lg" />
      <p class="mt-1.5 text-sm" :class="stockLine.class">{{ stockLine.text }}</p>
    </div>

    <!-- Colourways -->
    <div v-if="product.colorways.length > 1" class="mt-6">
      <p class="text-sm font-medium">
        Finish: <span class="font-normal text-text-secondary">{{ variant.name }}</span>
      </p>
      <div class="mt-2 flex gap-2">
        <button
          v-for="option in product.colorways"
          :key="option.name"
          type="button"
          class="h-9 w-9 rounded-full border-2 transition-transform"
          :class="
            variant.name === option.name ? 'scale-110 border-accent' : 'border-white/20 hover:border-white/50'
          "
          :style="{ backgroundColor: option.hex }"
          :aria-label="`Select ${option.name}`"
          :aria-pressed="variant.name === option.name"
          @click="variant = option"
        />
      </div>
    </div>

    <!-- Quantity + add -->
    <div class="mt-8 flex flex-wrap items-center gap-3">
      <div class="flex items-center rounded border border-border-hairline">
        <button
          type="button"
          class="px-3 py-2.5 text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary disabled:opacity-30"
          :disabled="qty <= 1"
          aria-label="Decrease quantity"
          @click="qty = Math.max(1, qty - 1)"
        >
          <Minus class="h-4 w-4" aria-hidden="true" />
        </button>
        <span class="nums w-10 text-center text-sm">{{ qty }}</span>
        <button
          type="button"
          class="px-3 py-2.5 text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary disabled:opacity-30"
          :disabled="qty >= product.stockCount"
          aria-label="Increase quantity"
          @click="qty = Math.min(product.stockCount, qty + 1)"
        >
          <Plus class="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <button
        type="button"
        class="flex-1 rounded px-6 py-3 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-text-muted"
        :class="
          added ? 'bg-accent-green/15 text-accent-green' : 'bg-accent text-white hover:bg-accent-hover'
        "
        :disabled="!product.inStock"
        @click="addToCart"
      >
        <span v-if="!product.inStock">Out of stock</span>
        <span v-else-if="added" class="flex items-center justify-center gap-2">
          Added to cart
          <Check class="h-4 w-4" aria-hidden="true" />
        </span>
        <span v-else>Add to cart</span>
      </button>
    </div>

    <ul class="mt-8 space-y-2.5 border-t border-border-hairline pt-6">
      <li
        v-for="item in assurances"
        :key="item.text"
        class="flex items-center gap-2.5 text-sm text-text-secondary"
      >
        <component :is="item.icon" class="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
        {{ item.text }}
      </li>
    </ul>
  </div>
</template>
