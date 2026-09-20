<script setup lang="ts">
/**
 * The swipeable photo strip inside a product card.
 *
 * It shows angles of one product, not colourways. The catalogue's finishes are
 * a shared design palette — "Midnight" appears under sixteen brands — so no
 * real photograph could ever match them, and a picture that contradicts its own
 * label is the defect this project keeps finding rather than a feature.
 *
 * The card's root element is a RouterLink, which makes a drag gesture
 * genuinely awkward: a pointer that moves and releases still produces a click,
 * and that click navigates. Everything below exists to let a drag be a drag.
 */
import { computed, ref } from 'vue'

const props = defineProps<{ images: string[]; alt: string }>()
/** So the card can stand its 3D tilt down while a drag is in progress. */
const emit = defineEmits<{ dragging: [boolean] }>()

/** Past this, the gesture is a swipe rather than a slightly sloppy click. */
const THRESHOLD_PX = 40

const index = ref(0)
/** Live finger offset, in px, while a drag is in progress. */
const offset = ref(0)
const dragging = ref(false)

/*
 * The hero is guaranteed by src/data/media.spec.ts; the rest are not. The
 * pipeline writes as many angles as it found — the Galaxy S26 Ultra stops at
 * three because its fourth candidate was marketing artwork — and a missing file
 * does not 404 here, it serves the SPA shell. So the tail is probed once, on
 * first interaction, and the strip is built from what actually decodes.
 */
const slides = ref<string[]>([props.images[0]])
let probing: Promise<void> | null = null

function probe(): Promise<void> {
  if (probing) return probing
  probing = Promise.all(
    props.images.map(
      (src) =>
        new Promise<string | null>((resolve) => {
          const img = new Image()
          img.onload = () => resolve(src)
          img.onerror = () => resolve(null)
          img.src = src
        }),
    ),
  ).then((results) => {
    const found = results.filter((src): src is string => src !== null)
    if (found.length) slides.value = found
  })
  return probing
}

const many = computed(() => slides.value.length > 1)

function go(to: number) {
  index.value = Math.min(Math.max(to, 0), slides.value.length - 1)
}

/* ------------------------------------------------------------------- drag */

let startX = 0
let moved = 0

function onPointerDown(event: PointerEvent) {
  if (!event.isPrimary || event.button !== 0) return
  void probe()
  startX = event.clientX
  moved = 0
  dragging.value = true
  emit('dragging', true)
  // Capture, so a drag that leaves the card still reports where it went.
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}

function onPointerMove(event: PointerEvent) {
  if (!dragging.value) return
  moved = event.clientX - startX
  // Resist at the ends rather than stopping dead: the card should feel like it
  // knows there is nothing further, not like it has jammed.
  const atEnd = (moved > 0 && index.value === 0) || (moved < 0 && index.value === slides.value.length - 1)
  offset.value = atEnd ? moved * 0.25 : moved
}

function onPointerUp(event: PointerEvent) {
  if (!dragging.value) return
  dragging.value = false
  emit('dragging', false)
  offset.value = 0

  if (Math.abs(moved) < THRESHOLD_PX) return
  go(index.value + (moved < 0 ? 1 : -1))

  /*
   * A completed drag still fires a click on the way up, and the click would
   * follow the link. Swallowing exactly the next one leaves ordinary clicks —
   * the ones that should open the product — working.
   */
  const el = event.currentTarget as HTMLElement
  el.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
  }, { capture: true, once: true })
}
</script>

<template>
  <div
    class="relative h-full w-full touch-pan-y select-none"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @pointerenter="probe"
    @focusin="probe"
  >
    <div
      class="flex h-full w-full"
      :class="!dragging && 'transition-transform duration-300 ease-out'"
      :style="{ transform: `translateX(calc(${-index * 100}% + ${offset}px))` }"
    >
      <img
        v-for="(src, i) in slides"
        :key="src"
        :src="src"
        :alt="i === 0 ? alt : ''"
        :aria-hidden="i === 0 ? undefined : 'true'"
        width="600"
        height="450"
        :loading="i === 0 ? 'lazy' : undefined"
        draggable="false"
        class="h-full w-full shrink-0 object-cover"
      />
    </div>

    <!--
      Dots are a control, not decoration, so they are real buttons — reachable
      by keyboard and announced. They stop the click from reaching the link
      because choosing a photo is not asking to leave the page.

      The drop shadow is not styling. White dots sit over 175 product
      photographs nobody has audited for what is behind the bottom edge, and on
      a white studio background they would simply vanish.
    -->
    <div
      v-if="many"
      class="absolute inset-x-0 bottom-3 z-10 flex justify-center gap-1.5 [filter:drop-shadow(0_1px_2px_rgb(0_0_0/0.6))]"
    >
      <button
        v-for="(src, i) in slides"
        :key="src"
        type="button"
        class="h-1.5 rounded-full transition-all"
        :class="i === index ? 'w-4 bg-white' : 'w-1.5 bg-white/45 hover:bg-white/70'"
        :aria-label="`Photo ${i + 1} of ${slides.length}`"
        :aria-current="i === index ? 'true' : undefined"
        @click.stop.prevent="go(i)"
      />
    </div>
  </div>
</template>
