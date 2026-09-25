<script setup lang="ts">
// Daily sales as bars, one currency per chart: bars in two currencies on one
// axis would compare cents with cents of something else.
//
// The SVG draws only marks and stretches to its box (preserveAspectRatio
// none), so it fills a 390px phone and a desktop card alike. Every piece of
// text is HTML around it, where stretching cannot distort it.
import { computed, ref } from 'vue'
import { formatMinor } from '../money'

const props = defineProps<{ days: { day: string; minor: number }[]; currency: string }>()

const W = 300
const H = 100
const GAP = 2

const max = computed(() => Math.max(0, ...props.days.map((d) => d.minor)))
const slot = computed(() => W / Math.max(props.days.length, 1))
const bars = computed(() =>
  props.days.map((d, i) => {
    // A day with any sales at all stays visible next to a record day.
    const h = max.value && d.minor ? Math.max((d.minor / max.value) * H, 1.5) : 0
    return { ...d, x: i * slot.value + GAP / 2, w: slot.value - GAP, y: H - h, h }
  }),
)

const hover = ref<number | null>(null)
const shown = computed(() => props.days[hover.value ?? props.days.length - 1])

const dayLabel = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
</script>

<template>
  <figure>
    <figcaption class="mb-3 flex items-baseline justify-between gap-3">
      <span class="label">
        <span class="mr-2 rounded border border-border-hairline px-1.5 py-0.5 font-mono text-[10px] text-text-muted">{{ currency }}</span>
        {{ shown ? dayLabel(shown.day) : '' }}{{ hover === null ? ' (today)' : '' }}
      </span>
      <span class="nums text-sm font-semibold text-text-primary">{{ shown ? formatMinor(shown.minor, currency) : '' }}</span>
    </figcaption>
    <div>
      <span class="nums mb-1 block text-[11px] text-text-muted">{{ formatMinor(max, currency) }}</span>
      <svg
        :viewBox="`0 0 ${W} ${H}`"
        preserveAspectRatio="none"
        class="block h-40 w-full"
        role="img"
        :aria-label="`Daily sales in ${currency} over the last ${days.length} days`"
        @mouseleave="hover = null"
      >
        <line x1="0" :x2="W" y1="0.25" y2="0.25" class="stroke-border-hairline" stroke-dasharray="2 2" vector-effect="non-scaling-stroke" />
        <line x1="0" :x2="W" :y1="H" :y2="H" class="stroke-border-strong" vector-effect="non-scaling-stroke" />
        <g v-for="(b, i) in bars" :key="b.day">
          <rect
            :x="b.x"
            :y="b.y"
            :width="b.w"
            :height="b.h"
            rx="0.6"
            :class="hover === i ? 'fill-accent-hover' : 'fill-accent'"
          />
          <!-- The hit target is the whole column, not the bar: a zero day is still hoverable. -->
          <rect :x="i * slot" y="0" :width="slot" :height="H" fill="transparent" @mouseenter="hover = i" @click="hover = i">
            <title>{{ dayLabel(b.day) }}: {{ formatMinor(b.minor, currency) }}</title>
          </rect>
        </g>
      </svg>
    </div>
    <div class="nums mt-2 flex justify-between text-[11px] text-text-muted">
      <span>{{ days[0] ? dayLabel(days[0].day) : '' }}</span>
      <span>{{ days.length ? dayLabel(days[days.length - 1].day) : '' }}</span>
    </div>
    <table class="sr-only">
      <caption>Daily sales, {{ currency }}</caption>
      <tr v-for="d in days" :key="d.day">
        <th scope="row">{{ d.day }}</th>
        <td>{{ formatMinor(d.minor, currency) }}</td>
      </tr>
    </table>
  </figure>
</template>
