<script setup lang="ts">
/**
 * The catalogue in four figures, rolling into place when the strip scrolls
 * into view. Every figure is counted from the live catalogue, so it moves when
 * a merchant publishes a product or stock sells: nothing here is a claim the
 * data does not back.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { catalogue } from '@/stores/catalog'
import { vReveal } from '@/lib/reveal'
import RollingText from '../../../console/src/components/RollingText.vue'

const stats = computed(() => {
  const items = catalogue.value
  return [
    { label: 'Products', value: items.length },
    { label: 'Brands', value: new Set(items.map((p) => p.brand)).size },
    { label: 'Categories', value: new Set(items.map((p) => p.category)).size },
    { label: 'Units in stock', value: items.reduce((sum, p) => sum + p.stockCount, 0) },
  ].map((s) => ({ ...s, text: s.value.toLocaleString('en-US') }))
})

const strip = ref<HTMLElement | null>(null)
/** Rolls once it is on screen: rolling above the fold the visitor never sees would waste the effect. */
const seen = ref(typeof IntersectionObserver === 'undefined')
let observer: IntersectionObserver | undefined
onMounted(() => {
  if (seen.value || !strip.value) return
  observer = new IntersectionObserver(
    ([entry]) => {
      if (entry?.isIntersecting) {
        seen.value = true
        observer?.disconnect()
      }
    },
    { threshold: 0.4 },
  )
  observer.observe(strip.value)
})
onUnmounted(() => observer?.disconnect())
</script>

<template>
  <section ref="strip" class="border-t border-border-hairline bg-void py-12 md:py-16" aria-label="The catalogue in numbers">
    <dl v-reveal class="mx-auto grid max-w-[1600px] grid-cols-2 gap-6 px-4 md:grid-cols-4 md:px-8">
      <div v-for="s in stats" :key="s.label" class="rounded-card border border-border-hairline bg-surface-1 p-5 md:p-6">
        <dt class="text-xs uppercase tracking-wider text-text-secondary">{{ s.label }}</dt>
        <dd class="nums mt-2 font-display text-3xl font-bold md:text-5xl">
          <RollingText :text="s.text" :run="seen" />
        </dd>
      </div>
    </dl>
  </section>
</template>
