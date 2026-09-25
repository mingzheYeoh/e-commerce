<script setup lang="ts">
defineProps<{ label: string; value: string; sub?: string }>()
</script>

<template>
  <div class="card p-4">
    <p class="label">{{ label }}</p>
    <p class="nums mt-1 break-words font-display text-xl font-bold text-text-primary">{{ value }}</p>
    <p v-if="sub" class="mt-1 text-xs text-text-secondary"><slot name="sub">{{ sub }}</slot></p>
  </div>
</template>
