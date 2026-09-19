<script setup lang="ts">
import { computed } from 'vue'
import type { Product } from '@/types'

const props = defineProps<{ product: Product }>()

const LOW_STOCK_THRESHOLD = 8

/**
 * One badge, resolved by priority: sold out beats low stock beats a marketing
 * badge. Each carries its own text — colour alone never conveys the state.
 */
const badge = computed(() => {
  const p = props.product
  if (!p.inStock || p.stockCount === 0) {
    return { label: 'SOLD OUT', class: 'border-text-muted/40 bg-void/80 text-text-muted' }
  }
  if (p.stockCount <= LOW_STOCK_THRESHOLD) {
    return {
      label: `LOW STOCK: ${p.stockCount} LEFT`,
      class: 'border-accent-amber/50 bg-accent-amber/15 text-accent-amber',
    }
  }
  if (p.badge === 'NEW_DROP') {
    return { label: 'NEW DROP', class: 'border-accent-cyan/50 bg-accent-cyan/15 text-accent-cyan' }
  }
  if (p.badge === 'LIMITED_EDITION') {
    return {
      label: 'LIMITED EDITION',
      class: 'border-accent-cyan/50 bg-accent-cyan/15 text-accent-cyan',
    }
  }
  if (p.badge === 'DISCOUNT') {
    return { label: 'PRICE DROP', class: 'border-accent-amber/50 bg-accent-amber/15 text-accent-amber' }
  }
  return null
})
</script>

<template>
  <span
    v-if="badge"
    class="border px-2 py-1 font-mono text-[10px] tracking-[0.12em] backdrop-blur-sm"
    :class="badge.class"
  >
    {{ badge.label }}
  </span>
</template>
