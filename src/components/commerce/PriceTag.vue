<script setup lang="ts">
import { useCurrency } from '@/composables/useCurrency'

defineProps<{ cents: number; size?: 'sm' | 'lg' }>()
const { format } = useCurrency()
</script>

<template>
  <span
    class="nums font-mono tracking-tight text-text-primary"
    :class="size === 'lg' ? 'text-xl md:text-2xl' : 'text-sm'"
  >
    {{ format(cents) }}
  </span>
</template>
