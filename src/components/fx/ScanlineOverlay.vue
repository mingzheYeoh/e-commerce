<script setup lang="ts">
/**
 * CRT scanlines + dot matrix. Purely decorative, so it is aria-hidden and never
 * intercepts pointer events.
 */
withDefaults(defineProps<{ dots?: boolean }>(), { dots: true })
</script>

<template>
  <div class="pointer-events-none absolute inset-0" aria-hidden="true">
    <div class="absolute inset-0 bg-scanlines bg-scan-4 opacity-60" />
    <div v-if="dots" class="absolute inset-0 bg-dot-matrix bg-dot-16 opacity-[0.35]" />
  </div>
</template>
