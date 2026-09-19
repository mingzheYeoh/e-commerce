<script setup lang="ts">
import { computed } from 'vue'
import type { Product } from '@/types'

const props = defineProps<{ product: Product }>()

const LOW_STOCK_THRESHOLD = 8

/**
 * One badge, resolved by priority: sold out beats low stock beats a marketing
 * label. Each carries its own words — colour alone never conveys the state.
 */
const badge = computed(() => {
  const p = props.product
  if (!p.inStock || p.stockCount === 0) {
    return { label: 'Sold out', class: 'bg-black/70 text-text-secondary' }
  }
  if (p.stockCount <= LOW_STOCK_THRESHOLD) {
    return { label: `Only ${p.stockCount} left`, class: 'bg-accent-amber/15 text-accent-amber' }
  }
  if (p.badge === 'NEW_DROP') {
    return { label: 'New', class: 'bg-accent/15 text-accent' }
  }
  if (p.badge === 'LIMITED_EDITION') {
    return { label: 'Limited edition', class: 'bg-accent/15 text-accent' }
  }
  if (p.badge === 'DISCOUNT') {
    return { label: 'Sale', class: 'bg-accent-amber/15 text-accent-amber' }
  }
  return null
})
</script>

<template>
  <span
    v-if="badge"
    class="rounded-full px-2.5 py-1 text-xs font-medium backdrop-blur-sm"
    :class="badge.class"
  >
    {{ badge.label }}
  </span>
</template>
