<script setup lang="ts">
import { useCurrency } from '@/composables/useCurrency'

defineProps<{ cents: number; size?: 'sm' | 'lg' }>()
const { format } = useCurrency()
</script>

<template>
  <span
    class="nums font-semibold text-text-primary"
    :class="size === 'lg' ? 'text-2xl' : 'text-base'"
  >
    {{ format(cents) }}
  </span>
</template>
