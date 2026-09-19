<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { Zap } from 'lucide-vue-next'
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

onMounted(() => {
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

  // Pin geometry is measured from laid-out heights; images finishing late would
  // otherwise leave the pin spacer the wrong size.
  window.addEventListener('load', () => ScrollTrigger.refresh())
})

onUnmounted(() => {
  trigger?.kill()
  trigger = null
})

const stage = computed(() => {
  if (progress.value < 0.25) return 'ASSEMBLED'
  if (progress.value < 0.65) return 'SEPARATING'
  return 'EXPLODED'
})

function preorder() {
  // The flagship is not in the catalog fixtures — it is configured here, so the
  // cart line is built from the chosen variant.
  const asProduct: Product = {
    id: 'flagship',
    sku: `${flagship.sku}-${variant.value.name.replace(/\s+/g, '').toUpperCase()}`,
    brand: flagship.brand,
    title: `${flagship.title} — ${variant.value.name}`,
    category: 'audio',
    price: flagship.price,
    currency: 'USD',
    inStock: true,
    stockCount: 25,
    rating: 5,
    reviewCount: 0,
    specsSummary: flagship.parts.map((p) => p.spec),
    media: { heroImage: flagship.image, thumb: flagship.image },
    colorways: flagship.variants,
  }
  cart.add(asProduct)
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
    <div class="pointer-events-none absolute inset-0 bg-dot-matrix bg-dot-16 opacity-30" aria-hidden="true" />

    <!-- Header rail -->
    <div class="relative z-10 flex items-start justify-between gap-4 px-4 pt-20 md:px-8 md:pt-24">
      <div>
        <p class="mono-label mb-2 text-accent-cyan">[03_FLAGSHIP]</p>
        <h2
          class="font-display text-2xl font-extrabold uppercase leading-none tracking-tighter md:text-4xl lg:text-5xl"
        >
          Deconstructed<span class="text-text-muted"> Flagship</span>
        </h2>
      </div>

      <!-- Scrub telemetry -->
      <div class="hidden shrink-0 text-right md:block">
        <p class="mono-label">TEARDOWN_STATE</p>
        <p class="font-mono text-sm tracking-[0.14em] text-accent-cyan">{{ stage }}</p>
        <div class="mt-2 h-px w-32 bg-border-hairline">
          <div class="h-px bg-accent-cyan" :style="{ width: `${progress * 100}%` }" />
        </div>
      </div>
    </div>

    <!-- Stage -->
    <div class="relative z-0 min-h-0 flex-1">
      <LayeredRenderer :progress="progress" :image="flagship.image" :parts="flagship.parts" />
    </div>

    <!-- Purchase panel -->
    <div class="relative z-10 px-4 pb-6 md:px-8 md:pb-10">
      <div
        class="hud-panel ml-auto flex w-full flex-col gap-4 p-4 md:max-w-xl md:flex-row md:items-end"
      >
        <div class="flex-1">
          <p class="mono-label">{{ flagship.sku }}</p>
          <p class="font-display text-base font-extrabold uppercase leading-tight tracking-tighter md:text-lg">
            {{ flagship.title }}
          </p>

          <div class="mt-3 flex items-center gap-2">
            <button
              v-for="option in flagship.variants"
              :key="option.name"
              type="button"
              class="h-6 w-6 border transition-transform"
              :class="
                variant.name === option.name
                  ? 'border-accent-cyan scale-110'
                  : 'border-white/20 hover:border-white/50'
              "
              :style="{ backgroundColor: option.hex }"
              :aria-label="`Select ${option.name} finish`"
              :aria-pressed="variant.name === option.name"
              @click="variant = option"
            />
            <span class="mono-label ml-1">{{ variant.name }}</span>
          </div>
        </div>

        <div class="shrink-0 md:text-right">
          <p class="nums font-display text-2xl font-extrabold tracking-tighter">
            {{ formatPrice(flagship.price) }}
          </p>
          <button
            type="button"
            class="mt-2 flex w-full items-center justify-center gap-2 px-4 py-2.5 font-mono text-[10px] font-bold tracking-[0.12em] transition-colors"
            :class="
              added
                ? 'bg-accent-neon/20 text-accent-neon'
                : 'bg-text-primary text-void hover:bg-accent-cyan'
            "
            @click="preorder"
          >
            <Zap class="h-3 w-3" aria-hidden="true" />
            {{ added ? 'RESERVED' : 'PRE-ORDER // 48H' }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>
