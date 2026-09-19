<script setup lang="ts">
import { computed } from 'vue'
import type { FlagshipPart, Colorway } from '@/types'

const props = defineProps<{
  /** 0 = assembled, 1 = fully exploded. */
  progress: number
  image: string
  parts: FlagshipPart[]
  /** Selected finish. Tints the product so switching it is actually visible. */
  variant: Colorway
}>()

/**
 * Everything is positioned with `left`/`top` percentages inside a SQUARE stage.
 *
 * That squareness is load-bearing: percentage margins and percentage translates
 * resolve against width (or the element's own box), so on a wide, short stage
 * an offset of "20%" means something different horizontally than vertically and
 * the diagram shears. A square stage makes one unit mean one thing, and it also
 * lets the SVG leader lines share the exact same coordinate space.
 */

/** Each node shows a magnified region of the same photo, so the components
 *  read as cut from this device rather than borrowed from another. */
const CROP_ORIGINS = ['32% 38%', '68% 34%', '30% 66%', '70% 64%']

const eased = computed(() => {
  const p = Math.min(Math.max(props.progress, 0), 1)
  return 1 - Math.pow(1 - p, 3) // easeOutCubic
})

/**
 * There is one photograph of this product, so a finish change is rendered as a
 * colour wash over the metal rather than three separate shots. `soft-light`
 * keeps the highlights and shadows of the real photo and only shifts its hue,
 * which reads as anodising rather than as a sticker.
 */
const tintStyle = computed(() => ({
  backgroundColor: props.variant.hex,
  mixBlendMode: 'soft-light' as const,
}))

const bodyStyle = computed(() => ({
  transform: `translate(-50%, -50%) scale(${1 - 0.3 * eased.value}) rotate(${eased.value * -5}deg)`,
  opacity: String(1 - 0.45 * eased.value),
}))

const nodeAt = (part: FlagshipPart) => ({
  x: 50 + part.offset.x * eased.value,
  y: 50 + part.offset.y * eased.value,
})

function nodeStyle(part: FlagshipPart) {
  const { x, y } = nodeAt(part)
  return {
    left: `${x}%`,
    top: `${y}%`,
    transform: `translate(-50%, -50%) scale(${0.65 + 0.35 * eased.value})`,
    opacity: String(Math.min(1, Math.max(0, (props.progress - part.revealAt * 0.35) * 2.6))),
  }
}

function chipStyle(index: number) {
  return {
    backgroundImage: `url(${props.image})`,
    backgroundSize: '300%',
    backgroundPosition: CROP_ORIGINS[index % CROP_ORIGINS.length],
  }
}

const labelOpacity = (part: FlagshipPart) =>
  props.progress < part.revealAt ? 0 : Math.min(1, (props.progress - part.revealAt) * 5)
</script>

<template>
  <div class="flex h-full w-full items-center justify-center">
    <div class="relative aspect-square h-full max-h-full">
      <svg
        class="pointer-events-none absolute inset-0 h-full w-full"
        viewBox="0 0 100 100"
        aria-hidden="true"
      >
        <line
          v-for="part in parts"
          :key="`line-${part.id}`"
          x1="50"
          y1="50"
          :x2="nodeAt(part).x"
          :y2="nodeAt(part).y"
          stroke="#0A84FF"
          stroke-width="0.2"
          stroke-dasharray="2 1.4"
          :opacity="labelOpacity(part) * 0.6"
        />
      </svg>

      <!-- Device body -->
      <div
        class="absolute left-1/2 top-1/2 w-[46%] overflow-hidden rounded-card border border-border-hairline will-change-transform"
        :style="bodyStyle"
      >
        <img
          :src="image"
          :alt="`HD 900 S reference headphones in ${variant.name}`"
          width="480"
          height="360"
          loading="lazy"
          class="h-full w-full object-cover"
        />
        <div class="absolute inset-0" :style="tintStyle" aria-hidden="true" />
      </div>

      <!-- Part node with its own callout, so a label can never drift off its part -->
      <div
        v-for="(part, index) in parts"
        :key="part.id"
        class="absolute w-[30%] will-change-transform"
        :style="nodeStyle(part)"
      >
        <div
          class="relative mx-auto h-16 w-16 overflow-hidden rounded border border-border-strong bg-surface-2 bg-no-repeat md:h-20 md:w-20"
          :style="chipStyle(index)"
          aria-hidden="true"
        >
          <div class="absolute inset-0" :style="tintStyle" />
        </div>
        <div class="mt-2 text-center" :style="{ opacity: String(labelOpacity(part)) }">
          <p class="text-xs font-semibold text-accent">{{ part.label }}</p>
          <p class="mt-0.5 text-xs leading-snug text-text-secondary">{{ part.spec }}</p>
        </div>
      </div>
    </div>
  </div>
</template>
