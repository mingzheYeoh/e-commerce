<script setup lang="ts">
import { computed } from 'vue'
import type { FlagshipPart } from '@/types'

const props = defineProps<{
  /** 0 = assembled, 1 = fully exploded. The only input this renderer takes. */
  progress: number
  image: string
  parts: FlagshipPart[]
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
  // easeOutCubic — parts leave decisively, then settle.
  const p = Math.min(Math.max(props.progress, 0), 1)
  return 1 - Math.pow(1 - p, 3)
})

const bodyStyle = computed(() => ({
  transform: `translate(-50%, -50%) scale(${1 - 0.3 * eased.value}) rotate(${eased.value * -5}deg)`,
  opacity: String(1 - 0.45 * eased.value),
}))

/** Node centre, in stage percentages. */
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

/** Labels fade in only once the part has travelled far enough to have room. */
const labelOpacity = (part: FlagshipPart) =>
  props.progress < part.revealAt ? 0 : Math.min(1, (props.progress - part.revealAt) * 5)
</script>

<template>
  <div class="flex h-full w-full items-center justify-center">
    <div class="relative aspect-square h-full max-h-full">
      <!-- Leader lines share the stage's coordinate space exactly -->
      <svg class="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 100" aria-hidden="true">
        <line
          v-for="part in parts"
          :key="`line-${part.id}`"
          x1="50"
          y1="50"
          :x2="nodeAt(part).x"
          :y2="nodeAt(part).y"
          stroke="#00F0FF"
          stroke-width="0.25"
          stroke-dasharray="2 1.2"
          :opacity="labelOpacity(part) * 0.7"
        />
        <circle cx="50" cy="50" r="0.7" fill="#00F0FF" :opacity="eased * 0.8" />
      </svg>

      <!-- Device body -->
      <div
        class="absolute left-1/2 top-1/2 w-[46%] overflow-hidden border border-border-hairline will-change-transform"
        :style="bodyStyle"
      >
        <img
          :src="image"
          alt="SPEC_01 Planar Reference headphones, shown disassembled"
          width="480"
          height="360"
          loading="lazy"
          class="h-full w-full object-cover"
        />
        <div class="absolute inset-0 bg-scanlines bg-scan-4 opacity-40" aria-hidden="true" />
      </div>

      <!-- Part node + its own callout, so a label can never drift off its part -->
      <div
        v-for="(part, index) in parts"
        :key="part.id"
        class="absolute w-[30%] will-change-transform"
        :style="nodeStyle(part)"
      >
        <div
          class="mx-auto h-16 w-16 border border-accent-cyan/60 bg-surface-2 bg-no-repeat shadow-lg shadow-accent-cyan/20 md:h-20 md:w-20"
          :style="chipStyle(index)"
          aria-hidden="true"
        />
        <div class="mt-2 text-center" :style="{ opacity: String(labelOpacity(part)) }">
          <p class="mono-label text-accent-cyan">[{{ part.label }}]</p>
          <p class="mt-0.5 text-[11px] leading-snug text-text-secondary md:text-xs">
            {{ part.spec }}
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
