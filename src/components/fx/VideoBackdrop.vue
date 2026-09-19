<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { prefersReducedMotion } from '@/composables/useReducedMotion'

const props = withDefaults(
  defineProps<{
    src: string
    poster: string
    /** Below this width the video is never fetched — only the poster renders. */
    minWidth?: number
  }>(),
  { minWidth: 768 },
)

/**
 * The video is a mood layer, not content. On phones it would be the single
 * largest download on the page for something that sits at 60% opacity behind
 * text, so there it stays a still. Same for reduced-motion visitors.
 */
const playVideo = ref(false)

onMounted(() => {
  playVideo.value = window.innerWidth >= props.minWidth && !prefersReducedMotion()
})
</script>

<template>
  <div class="absolute inset-0 overflow-hidden bg-void" aria-hidden="true">
    <video
      v-if="playVideo"
      :poster="poster"
      autoplay
      loop
      muted
      playsinline
      preload="metadata"
      class="h-full w-full object-cover opacity-[0.55] contrast-125 saturate-150 brightness-[0.7]"
    >
      <source :src="src" type="video/mp4" />
    </video>
    <img
      v-else
      :src="poster"
      alt=""
      width="1280"
      height="720"
      loading="eager"
      fetchpriority="high"
      class="h-full w-full object-cover opacity-[0.45] contrast-125 saturate-150 brightness-[0.7]"
    />

    <!-- Melt the footage into the page: linear fade top/bottom, radial vignette -->
    <div class="absolute inset-0 bg-gradient-to-t from-void via-void/20 to-void/80" />
    <div
      class="absolute inset-0"
      style="background: radial-gradient(ellipse at center, transparent 0%, rgba(5, 5, 5, 0.9) 100%)"
    />
  </div>
</template>
