<script setup lang="ts">
import RollingText from './RollingText.vue'

defineProps<{ label: string; value: string; sub?: string }>()
</script>

<template>
  <!-- h-full: a card inside a router-link otherwise stops at its own content
       while the grid stretches the link, and a row of tiles comes out ragged. -->
  <div class="card h-full p-4 transition-transform duration-200 hover:-translate-y-0.5">
    <p class="label">{{ label }}</p>
    <p class="nums mt-1 break-words font-display text-xl font-bold text-text-primary"><RollingText :text="value" /></p>
    <p v-if="sub" class="mt-1 text-xs text-text-secondary"><slot name="sub">{{ sub }}</slot></p>
  </div>
</template>
