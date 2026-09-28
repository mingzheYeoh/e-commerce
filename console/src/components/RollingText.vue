<script setup lang="ts">
/**
 * A figure whose digits roll into place like an odometer.
 *
 * Every digit is a column of 0-9 that slides to its value; the ones column
 * settles first and each higher place a beat later, so "5,446" arrives right
 * to left. Anything that is not a digit ($ , . RM "active") is printed as it
 * is, which is why this takes the formatted string rather than a number: the
 * money formatting stays where it already lives.
 *
 * When the text changes (a refresh brings a new order) each column rolls from
 * its old digit to its new one. Columns are keyed by place from the right, so
 * a number that gains a digit keeps its ones column where it was.
 *
 * Screen readers get the text once; the columns are hidden from them. Under
 * reduced motion the text is simply printed.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { motionReduced } from '../motion'

const props = withDefaults(defineProps<{ text: string; run?: boolean }>(), { run: true })

const reduced = motionReduced()
/** False until first paint: the columns start at 0 and roll from there. */
const settled = ref(false)
const settle = () => requestAnimationFrame(() => requestAnimationFrame(() => (settled.value = true)))
onMounted(() => props.run && settle())
watch(
  () => props.run,
  (run) => run && !settled.value && settle(),
)

/** Three runs of 0-9, landing in the third, so the first roll spins twice before it stops. */
const STRIP = 30
const LAND = 20

type Cell = { key: string; char: string; digit?: number; place?: number }

const cells = computed<Cell[]>(() => {
  const chars = [...props.text]
  const out: Cell[] = []
  let place = 0
  for (let i = chars.length - 1; i >= 0; i--) {
    const c = chars[i]!
    if (c >= '0' && c <= '9') {
      out.push({ key: `d${place}`, char: c, digit: Number(c), place })
      place++
    } else {
      out.push({ key: `c${chars.length - 1 - i}`, char: c })
    }
  }
  return out.reverse()
})

const stripStyle = (cell: Cell) => ({
  transform: `translateY(-${(((settled.value ? LAND + cell.digit! : 0) * 100) / STRIP).toFixed(4)}%)`,
  transitionDuration: `${700 + cell.place! * 160}ms`,
})
</script>

<template>
  <span v-if="reduced">{{ text }}</span>
  <span v-else class="rolling">
    <span class="sr-only">{{ text }}</span>
    <span
      v-for="cell in cells"
      :key="cell.key"
      aria-hidden="true"
      :class="cell.digit === undefined ? 'rolling-char' : 'rolling-col'"
      :data-digit="cell.digit"
    >
      <template v-if="cell.digit === undefined">{{ cell.char }}</template>
      <span v-else class="rolling-strip" :style="stripStyle(cell)">
        <span v-for="n in STRIP" :key="n">{{ (n - 1) % 10 }}</span>
      </span>
    </span>
  </span>
</template>

<style scoped>
.rolling {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: flex-start;
  font-variant-numeric: tabular-nums;
}
.rolling-char {
  display: inline-block;
  white-space: pre;
  line-height: 1.2em;
  height: 1.2em;
}
.rolling-col {
  display: inline-block;
  overflow: hidden;
  height: 1.2em;
}
.rolling-strip {
  display: flex;
  flex-direction: column;
  line-height: 1.2em;
  transition-property: transform;
  transition-timing-function: cubic-bezier(0.16, 1, 0.3, 1);
}
</style>
