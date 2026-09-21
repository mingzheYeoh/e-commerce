<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { brandName } from '@/data/brands'
import LayeredRenderer from './flagship/LayeredRenderer.vue'
import { flagship } from '@/data/flagship'
import { useCartStore } from '@/stores/cart'
import { useCurrency } from '@/composables/useCurrency'
import { prefersReducedMotion } from '@/composables/useReducedMotion'
import type { Product } from '@/types'

const cart = useCartStore()
const { formatPrice } = useCurrency()

const section = ref<HTMLElement | null>(null)
const progress = ref(0)
const variant = ref(flagship.variants[0])
const added = ref(false)

let trigger: ScrollTrigger | null = null

onMounted(async () => {
  // Static fallback: show the fully exploded state with every callout visible,
  // so a reduced-motion visitor gets the information, just not the choreography.
  if (prefersReducedMotion()) {
    progress.value = 1
    return
  }

  trigger = ScrollTrigger.create({
    trigger: section.value!,
    start: 'top top',
    end: '+=300%',
    pin: true,
    scrub: 1,
    onUpdate: (self) => {
      progress.value = self.progress
    },
  })

  // Pin geometry is measured after layout settles. A 'load' listener would not
  // do: on a client-side route change that event has already fired and never
  // fires again, so the spacer would keep the previous page's measurements.
  await nextTick()
  ScrollTrigger.refresh()
})

onUnmounted(() => {
  trigger?.kill()
  trigger = null
})

const stage = computed(() => {
  if (progress.value < 0.25) return 'Assembled'
  if (progress.value < 0.65) return 'Separating'
  return 'Exploded view'
})

function preorder() {
  // The flagship is not in the catalog fixtures — it is configured here, so the
  // cart line is built from the chosen variant.
  /*
   * The sku is the real one. It used to carry the variant as a suffix —
   * `SEN-HD900-113-CARBON` — which reads fine in a basket and is refused by the
   * order endpoint as an unknown sku. Storing an order is deliberately
   * fire-and-forget, so every preorder simply never reached the database and
   * nothing anywhere said so. The finish is a field now, not a spelling.
   */
  const asProduct: Product = {
    id: 'flagship',
    sku: flagship.sku,
    brand: flagship.brand,
    title: flagship.title,
    category: 'audio',
    // flagship.price is Flagship's own dollar field, not the catalogue's —
    // this is the one place a Flagship becomes a Product for the cart.
    priceMinor: Math.round(flagship.price * 100),
    currency: 'USD',
    inStock: true,
    stockCount: 25,
    rating: 5,
    reviewCount: 0,
    specsSummary: flagship.parts.map((p) => p.spec),
    specs: flagship.parts.map((p) => ({ label: p.label, value: p.spec })),
    media: { heroImage: flagship.image, thumb: flagship.image, gallery: [flagship.image] },
    colorways: flagship.variants,
  }
  cart.add(asProduct, 1, variant.value.name)
  added.value = true
  window.setTimeout(() => (added.value = false), 1200)
}
</script>

<template>
  <section
    id="flagship"
    ref="section"
    class="relative flex h-screen min-h-[640px] w-full flex-col overflow-hidden border-t border-border-hairline bg-void"
  >
    

    <!-- Header rail -->
    <div class="relative z-10 flex items-start justify-between gap-4 px-4 pt-20 md:px-8 md:pt-24">
      <div>
        <p class="mb-2 text-sm font-medium text-accent">Featured product</p>
        <h2 class="text-2xl font-bold md:text-4xl">Inside the {{ flagship.title }}</h2>
        <p class="mt-2 max-w-md text-sm text-text-secondary">
          Scroll to take it apart, component by component.
        </p>
      </div>

      <!-- Scrub telemetry -->
      <div class="hidden shrink-0 text-right md:block">
        <p class="text-xs text-text-secondary">View</p>
        <p class="text-sm font-medium text-accent">{{ stage }}</p>
        <div class="mt-2 h-1 w-32 overflow-hidden rounded-full bg-surface-2">
          <div class="h-full rounded-full bg-accent" :style="{ width: `${progress * 100}%` }" />
        </div>
      </div>
    </div>

    <!-- Stage -->
    <div class="relative z-0 min-h-0 flex-1">
      <LayeredRenderer
        :progress="progress"
        :image="flagship.image"
        :parts="flagship.parts"
        :variant="variant"
      />
    </div>

    <!-- Purchase panel -->
    <div class="relative z-10 px-4 pb-6 md:px-8 md:pb-10">
      <div
        class="card ml-auto flex w-full flex-col gap-4 bg-surface-1/90 p-4 backdrop-blur-xl md:max-w-xl md:flex-row md:items-end"
      >
        <div class="flex-1">
          <p class="text-xs text-text-secondary">{{ brandName(flagship.brand) }}</p>
          <p class="text-base font-semibold leading-tight md:text-lg">
            {{ flagship.title }}
          </p>

          <div class="mt-3 flex items-center gap-2">
            <button
              v-for="option in flagship.variants"
              :key="option.name"
              type="button"
              class="h-7 w-7 rounded-full border-2 transition-transform"
              :class="
                variant.name === option.name
                  ? 'scale-110 border-accent'
                  : 'border-white/20 hover:border-white/50'
              "
              :style="{ backgroundColor: option.hex }"
              :aria-label="`Select ${option.name} finish`"
              :aria-pressed="variant.name === option.name"
              @click="variant = option"
            />
            <span class="ml-1 text-sm text-text-secondary">{{ variant.name }}</span>
          </div>
        </div>

        <div class="shrink-0 md:text-right">
          <p class="nums text-2xl font-bold">
            {{ formatPrice(flagship.price) }}
          </p>
          <button
            type="button"
            class="mt-2 w-full rounded px-4 py-2.5 text-sm font-semibold transition-colors"
            :class="added ? 'bg-accent-green/15 text-accent-green' : 'bg-accent text-white hover:bg-accent-hover'"
            @click="preorder"
          >
            {{ added ? 'Added to cart' : 'Add to cart' }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>
