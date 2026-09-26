<script setup lang="ts">
/**
 * The stand-in for a bank's or wallet's own screen.
 *
 * It says what it is in its title and imitates nobody: no logos, no login
 * form, no colours borrowed from a bank — the channel is a name in plain text
 * and the choices are the outcomes a real payment can have. Nothing is sent
 * anywhere from here; the checkout acts on the outcome it reports.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { Landmark, Wallet } from 'lucide-vue-next'
import type { SimOutcome } from '@/lib/payment'

const props = defineProps<{ method: 'fpx' | 'ewallet'; channel: string; amount: string }>()
const emit = defineEmits<{ done: [outcome: SimOutcome] }>()

/** An e-wallet QR is good for three minutes, then the payment times out. */
const LIMIT_S = 180
const left = ref(LIMIT_S)
const clock = computed(() => `${Math.floor(left.value / 60)}:${String(left.value % 60).padStart(2, '0')}`)

let settled = false
function finish(outcome: SimOutcome) {
  if (settled) return
  settled = true
  emit('done', outcome)
}

let timer: ReturnType<typeof setInterval> | undefined
const first = ref<HTMLButtonElement | null>(null)
onMounted(() => {
  first.value?.focus()
  if (props.method !== 'ewallet') return
  timer = setInterval(() => {
    left.value -= 1
    if (left.value <= 0) {
      clearInterval(timer)
      finish('timeout')
    }
  }, 1000)
})
onUnmounted(() => clearInterval(timer))

/*
 * A decorative code, drawn here from a seeded generator: it encodes nothing
 * and no scanner will read it. The three corner squares are what make a grid
 * of dots read as "scan me" at a glance.
 */
const N = 21
const cells = computed(() => {
  let seed = [...`${props.channel}${props.amount}`].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)
  const next = () => {
    seed = (seed + 0x6d2b79f5) >>> 0
    let t = seed
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const finder = (x: number, y: number) =>
    [
      [0, 0],
      [N - 7, 0],
      [0, N - 7],
    ].some(([fx, fy]) => x >= fx && x < fx + 7 && y >= fy && y < fy + 7)
  const out: { x: number; y: number }[] = []
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (!finder(x, y) && next() < 0.5) out.push({ x, y })
  return out
})
const FINDERS = [
  [0, 0],
  [N - 7, 0],
  [0, N - 7],
]
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" @keydown.esc="finish('cancelled')">
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="sim-title"
      class="w-full max-w-sm rounded-card border border-border-hairline bg-surface-1 p-6"
    >
      <h2 id="sim-title" class="text-sm font-semibold">NEXUSOHM payment simulator — no real bank is contacted</h2>
      <p class="mt-3 flex items-center gap-2 text-sm text-text-secondary">
        <Landmark v-if="method === 'fpx'" class="h-4 w-4 shrink-0" aria-hidden="true" />
        <Wallet v-else class="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>
          {{ amount }} with <span class="font-medium text-text-primary">{{ channel }}</span>
          ({{ method === 'fpx' ? 'FPX online banking' : 'e-wallet' }})
        </span>
      </p>

      <template v-if="method === 'fpx'">
        <p class="mt-3 text-xs text-text-muted">Choose what the bank would answer.</p>
        <div class="mt-4 grid gap-2">
          <button ref="first" type="button" class="btn-primary" @click="finish('approved')">Approve</button>
          <button type="button" class="btn-ghost" @click="finish('declined')">Decline</button>
          <button type="button" class="btn-ghost" @click="finish('timeout')">Time out</button>
        </div>
      </template>

      <template v-else>
        <div class="mt-4 flex flex-col items-center gap-2">
          <svg
            :viewBox="`-2 -2 ${N + 4} ${N + 4}`"
            width="168"
            height="168"
            class="rounded bg-white"
            aria-hidden="true"
          >
            <rect v-for="c in cells" :key="`${c.x}-${c.y}`" :x="c.x" :y="c.y" width="1" height="1" fill="#111" />
            <g v-for="[fx, fy] in FINDERS" :key="`${fx}-${fy}`">
              <rect :x="fx" :y="fy" width="7" height="7" fill="#111" />
              <rect :x="fx + 1" :y="fy + 1" width="5" height="5" fill="#fff" />
              <rect :x="fx + 2" :y="fy + 2" width="3" height="3" fill="#111" />
            </g>
          </svg>
          <p class="text-xs text-text-muted">Decorative only: this code encodes nothing.</p>
          <p class="nums text-sm" role="timer" aria-live="off">Expires in {{ clock }}</p>
        </div>
        <div class="mt-4 grid gap-2">
          <button ref="first" type="button" class="btn-primary" @click="finish('approved')">Simulate paid</button>
          <button type="button" class="btn-ghost" @click="finish('cancelled')">Cancel</button>
        </div>
      </template>
    </div>
  </div>
</template>
