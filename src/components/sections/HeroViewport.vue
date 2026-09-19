<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { ArrowDown, Plus } from 'lucide-vue-next'
import VideoBackdrop from '@/components/fx/VideoBackdrop.vue'
import ScanlineOverlay from '@/components/fx/ScanlineOverlay.vue'
import { featuredDrop } from '@/data/products'
import { useCartStore } from '@/stores/cart'
import { useCurrency } from '@/composables/useCurrency'

const cart = useCartStore()
const { formatPrice } = useCurrency()

// Live UTC readout in the telemetry strip. Cheap, and it makes the HUD read as
// instrumentation rather than decoration.
const clock = ref('--:--:--')
let timer: number | undefined

const tick = () => {
  clock.value = new Date().toISOString().slice(11, 19)
}

onMounted(() => {
  tick()
  timer = window.setInterval(tick, 1000)
})
onUnmounted(() => window.clearInterval(timer))
</script>

<template>
  <section
    id="top"
    class="relative flex h-screen min-h-[640px] w-full select-none flex-col justify-between overflow-hidden bg-void px-4 pb-6 pt-20 md:px-8 md:pb-10"
  >
    <VideoBackdrop
      src="/media/video/hero-grid.mp4"
      poster="/media/video/hero-grid-poster.webp"
    />
    <ScanlineOverlay />

    <!-- Telemetry strip -->
    <div
      class="relative z-10 flex items-center justify-between border-b border-border-hairline pb-3 font-mono text-[10px] tracking-[0.16em] text-text-secondary md:text-[11px]"
    >
      <p class="flex min-w-0 items-center gap-2">
        <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-neon" aria-hidden="true" />
        <span class="truncate">SYS_STATUS // ONLINE — CATALOG_EXPANDED [2026_EDITION]</span>
      </p>
      <p class="hidden shrink-0 gap-4 lg:flex">
        <span class="nums text-text-muted">UTC {{ clock }}</span>
        <span>GLOBAL_DISPATCH: ACTIVE // 48H EXPRESS</span>
      </p>
    </div>

    <!-- Value proposition -->
    <div class="relative z-10 my-auto max-w-5xl py-10">
      <p
        class="mb-5 inline-block border border-accent-cyan/40 bg-accent-cyan/10 px-3 py-1 font-mono text-[10px] tracking-[0.2em] text-accent-cyan md:text-xs"
      >
        PREMIER HARDWARE COLLECTIVE
      </p>

      <h1
        class="font-display text-[2.4rem] font-extrabold uppercase leading-[0.85] tracking-tighter text-text-primary xs:text-5xl sm:text-7xl lg:text-8xl xl:text-9xl"
      >
        Machined
        <br />
        <span
          class="bg-gradient-to-r from-text-primary via-text-secondary to-accent-cyan bg-clip-text text-transparent"
        >
          Reality.
        </span>
      </h1>

      <p class="mt-6 max-w-xl text-pretty text-base leading-relaxed text-text-secondary md:text-lg">
        High-fidelity acoustics, transparent mechanical interfaces and autonomous flight optics,
        curated from six of the world's elite engineering labs.
      </p>
    </div>

    <!-- Quick-buy + scroll prompt -->
    <div
      class="relative z-10 flex flex-col items-start justify-between gap-5 border-t border-border-hairline pt-4 md:flex-row md:items-end"
    >
      <article
        class="hud-panel group flex w-full items-center gap-4 p-3 transition-colors hover:border-accent-cyan/50 md:w-auto"
      >
        <img
          :src="featuredDrop.media.thumb"
          :alt="featuredDrop.title"
          width="56"
          height="56"
          loading="eager"
          class="h-14 w-14 shrink-0 border border-border-hairline bg-surface-2 object-cover transition-transform duration-500 group-hover:scale-105"
        />

        <div class="min-w-0 flex-1 font-mono text-xs">
          <p class="flex items-center gap-1.5 font-bold text-accent-amber">
            <span class="h-1 w-1 animate-flicker bg-accent-amber" aria-hidden="true" />
            DROP_OF_THE_DAY
          </p>
          <p class="truncate text-sm font-bold tracking-tight text-text-primary">
            {{ featuredDrop.title }}
          </p>
          <p class="nums text-text-secondary">
            {{ formatPrice(featuredDrop.price) }} — {{ featuredDrop.stockCount }} UNITS LEFT
          </p>
        </div>

        <button
          type="button"
          class="flex shrink-0 items-center gap-1.5 bg-text-primary px-4 py-2.5 font-mono text-[11px] font-bold uppercase tracking-[0.12em] text-void transition-colors hover:bg-accent-cyan"
          :aria-label="`Quick add ${featuredDrop.title} to bag`"
          @click="cart.add(featuredDrop)"
        >
          QUICK BUY
          <Plus class="h-3 w-3" aria-hidden="true" />
        </button>
      </article>

      <a
        href="#brands"
        class="flex shrink-0 items-center gap-3 font-mono text-[10px] tracking-[0.16em] text-text-secondary transition-colors hover:text-accent-cyan md:text-[11px]"
      >
        <span class="h-px w-10 bg-text-secondary/40" aria-hidden="true" />
        INITIATE_SCROLL_EXPLORATION
        <ArrowDown class="h-3.5 w-3.5 animate-bounce" aria-hidden="true" />
      </a>
    </div>
  </section>
</template>
