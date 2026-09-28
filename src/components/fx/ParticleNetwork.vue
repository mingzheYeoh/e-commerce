<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

/**
 * The three.js hero backdrop. HeroViewport decides whether it runs at all
 * (see lib/hero-fallback); this only loads it politely: three.js is fetched
 * after mount, once the browser is idle, so it never competes with the
 * headline or the LCP image. Anything failing on the way emits `fail` and the
 * hero goes back to the video/poster.
 */
const emit = defineEmits<{ fail: [] }>()

const host = ref<HTMLElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const shown = ref(false)

let dispose: (() => void) | null = null
let cancelIdle = () => {}
let gone = false

async function start() {
  try {
    const { mountParticleNetwork } = await import('./particle-network')
    if (gone || !host.value || !canvas.value) return
    dispose = mountParticleNetwork(host.value, canvas.value, () => (shown.value = true))
  } catch {
    if (!gone) emit('fail')
  }
}

onMounted(() => {
  if ('requestIdleCallback' in window) {
    const id = window.requestIdleCallback(() => void start(), { timeout: 2000 })
    cancelIdle = () => window.cancelIdleCallback(id)
  } else {
    const id = setTimeout(() => void start(), 300)
    cancelIdle = () => clearTimeout(id)
  }
})

onUnmounted(() => {
  gone = true
  cancelIdle()
  dispose?.()
})
</script>

<template>
  <div ref="host" class="absolute inset-0 overflow-hidden bg-void" aria-hidden="true">
    <!-- A faint accent bloom where the network will sit, so the idle wait is
         not a flat black rectangle. -->
    <div
      class="absolute inset-0"
      style="background: radial-gradient(40% 55% at 68% 50%, rgba(10, 132, 255, 0.08), transparent 70%)"
    />
    <canvas
      ref="canvas"
      class="absolute inset-0 h-full w-full transition-opacity duration-[1400ms] ease-out"
      :class="shown ? 'opacity-100' : 'opacity-0'"
    />

    <!-- Same melt into the page as the video backdrop -->
    <div class="absolute inset-0 bg-gradient-to-t from-void via-void/10 to-void/70" />
    <div
      class="absolute inset-0"
      style="background: radial-gradient(ellipse at 60% 50%, transparent 30%, rgba(11, 11, 13, 0.85) 100%)"
    />
  </div>
</template>
