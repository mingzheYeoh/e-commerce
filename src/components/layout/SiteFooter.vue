<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ShieldCheck, Truck, BadgeCheck, ChevronDown } from 'lucide-vue-next'
import credits from '@/data/credits.json'
import type { Credit } from '@/types'

const VERSION = 'V2.6.4_RELEASE'

/* -------------------------------------------------- newsletter ----------- */
const email = ref('')
const status = ref<'idle' | 'error' | 'done'>('idle')

function subscribe() {
  // Native validity first — the browser already knows what an email looks like,
  // and its rules are better than any regex written here.
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.value.trim())
  if (!valid) {
    status.value = 'error'
    return
  }
  status.value = 'done'
  email.value = ''
}

/* -------------------------------------------------- telemetry ------------ */
const now = ref(new Date())
let timer: number | undefined
onMounted(() => {
  timer = window.setInterval(() => (now.value = new Date()), 1000)
})
onUnmounted(() => window.clearInterval(timer))

const utc = computed(() => now.value.toISOString().slice(11, 19))
const local = computed(() =>
  now.value.toLocaleTimeString('en-GB', { hour12: false }),
)

/* -------------------------------------------------- credits -------------- */
const showCredits = ref(false)

// One entry per photographer; the same person often shot several assets.
const photographers = computed(() => {
  const seen = new Map<string, Credit>()
  for (const credit of credits as Credit[]) {
    if (!seen.has(credit.photographer)) seen.set(credit.photographer, credit)
  }
  return [...seen.values()].sort((a, b) => a.photographer.localeCompare(b.photographer))
})

const guarantees = [
  { icon: ShieldCheck, label: 'ENCRYPTED GATEWAY', detail: 'PCI-DSS // 3DS2' },
  { icon: BadgeCheck, label: '24-MONTH WARRANTY', detail: 'PARTS & LABOUR' },
  { icon: Truck, label: 'GLOBAL FREIGHT', detail: '48H EXPRESS DISPATCH' },
]
</script>

<template>
  <footer class="border-t border-border-hairline bg-void">
    <!-- Newsletter -->
    <div class="border-b border-border-hairline">
      <div
        class="mx-auto flex max-w-[1800px] flex-col gap-6 px-4 py-12 md:flex-row md:items-center md:justify-between md:px-8"
      >
        <div>
          <h2 class="font-display text-xl font-extrabold uppercase tracking-tighter md:text-3xl">
            Subscribe to firmware<br class="hidden md:block" />
            updates &amp; hardware drops
          </h2>
          <p class="mono-label mt-2">NO MARKETING NOISE // DISPATCH ALERTS ONLY</p>
        </div>

        <form class="w-full max-w-md" novalidate @submit.prevent="subscribe">
          <div
            class="flex items-center gap-2 border bg-surface-1 px-3 py-2.5 transition-colors"
            :class="status === 'error' ? 'border-accent-amber' : 'border-border-hairline'"
          >
            <label for="newsletter" class="mono-label shrink-0 text-accent-cyan">
              ENTER_EMAIL:
            </label>
            <input
              id="newsletter"
              v-model="email"
              type="email"
              autocomplete="email"
              placeholder="_"
              :aria-invalid="status === 'error'"
              aria-describedby="newsletter-status"
              class="w-full bg-transparent font-mono text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
              @input="status = 'idle'"
            />
            <button
              type="submit"
              class="shrink-0 bg-text-primary px-3 py-1.5 font-mono text-[10px] font-bold tracking-[0.12em] text-void transition-colors hover:bg-accent-cyan"
            >
              TRANSMIT
            </button>
          </div>

          <p
            id="newsletter-status"
            role="status"
            class="mono-label mt-2 h-4"
            :class="status === 'error' ? 'text-accent-amber' : 'text-accent-neon'"
          >
            <template v-if="status === 'error'">ERR_INVALID_ADDRESS // RETRY</template>
            <template v-else-if="status === 'done'">SUBSCRIBED — CHANNEL OPEN</template>
          </p>
        </form>
      </div>
    </div>

    <!-- Guarantees -->
    <div class="border-b border-border-hairline">
      <ul class="mx-auto grid max-w-[1800px] grid-cols-1 sm:grid-cols-3">
        <li
          v-for="(item, index) in guarantees"
          :key="item.label"
          class="flex items-center gap-3 px-4 py-5 md:px-8"
          :class="index > 0 && 'border-t border-border-hairline sm:border-l sm:border-t-0'"
        >
          <component :is="item.icon" class="h-4 w-4 shrink-0 text-accent-cyan" aria-hidden="true" />
          <div>
            <p class="font-mono text-[11px] tracking-[0.14em] text-text-primary">{{ item.label }}</p>
            <p class="mono-label">{{ item.detail }}</p>
          </div>
        </li>
      </ul>
    </div>

    <!-- Photo credits -->
    <div class="border-b border-border-hairline">
      <div class="mx-auto max-w-[1800px] px-4 py-4 md:px-8">
        <button
          type="button"
          class="flex items-center gap-2 font-mono text-[11px] tracking-[0.14em] text-text-secondary transition-colors hover:text-text-primary"
          :aria-expanded="showCredits"
          aria-controls="credits-list"
          @click="showCredits = !showCredits"
        >
          <ChevronDown
            class="h-3.5 w-3.5 transition-transform"
            :class="showCredits && 'rotate-180'"
            aria-hidden="true"
          />
          PHOTOGRAPHY_CREDITS ({{ photographers.length }})
        </button>

        <ul
          v-show="showCredits"
          id="credits-list"
          class="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 md:grid-cols-4 lg:grid-cols-6"
        >
          <li v-for="credit in photographers" :key="credit.photographer">
            <a
              :href="credit.profileUrl"
              target="_blank"
              rel="noopener noreferrer"
              class="mono-label transition-colors hover:text-accent-cyan"
            >
              {{ credit.photographer }}
            </a>
          </li>
        </ul>
      </div>
    </div>

    <!-- System readout -->
    <div class="mx-auto max-w-[1800px] px-4 py-6 md:px-8">
      <div
        class="flex flex-col gap-3 font-mono text-[10px] tracking-[0.14em] text-text-muted md:flex-row md:items-center md:justify-between"
      >
        <p class="flex items-center gap-2">
          <span class="h-1.5 w-1.5 rounded-full bg-accent-neon" aria-hidden="true" />
          NEXUS_//[TECH] COLLECTIVE — DEMO STOREFRONT, NOT A REAL RETAILER
        </p>
        <p class="nums flex flex-wrap gap-x-5 gap-y-1">
          <span>UTC {{ utc }}</span>
          <span>LOCAL {{ local }}</span>
          <span>PING 24ms</span>
          <span class="text-text-secondary">{{ VERSION }}</span>
        </p>
      </div>
    </div>
  </footer>
</template>
