<script setup lang="ts">
import { computed, ref } from 'vue'
import { ShieldCheck, Truck, BadgeCheck, ChevronDown } from 'lucide-vue-next'
import credits from '@/data/credits.json'
import type { Credit } from '@/types'

const YEAR = new Date().getFullYear()

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
  { icon: ShieldCheck, label: 'Secure payments', detail: 'Encrypted checkout, PCI-DSS compliant' },
  { icon: BadgeCheck, label: '2-year warranty', detail: 'Parts and labour on every product' },
  { icon: Truck, label: 'Free express delivery', detail: 'On orders over $200, ships in 48h' },
]
</script>

<template>
  <footer class="border-t border-border-hairline bg-void">
    <!-- Newsletter -->
    <div class="border-b border-border-hairline">
      <div
        class="mx-auto flex max-w-[1600px] flex-col gap-6 px-4 py-12 md:flex-row md:items-center md:justify-between md:px-8"
      >
        <div>
          <h2 class="text-xl font-bold md:text-3xl">
            Get new arrivals and offers first
          </h2>
          <p class="mt-2 text-sm text-text-secondary">One email a week. Unsubscribe any time.</p>
        </div>

        <form class="w-full max-w-md" novalidate @submit.prevent="subscribe">
          <div
            class="flex items-center gap-2 rounded border bg-surface-1 px-3 py-2 transition-colors"
            :class="status === 'error' ? 'border-accent-amber' : 'border-border-hairline'"
          >
            <label for="newsletter" class="sr-only">Email address</label>
            <input
              id="newsletter"
              v-model="email"
              type="email"
              autocomplete="email"
              placeholder="you@example.com"
              :aria-invalid="status === 'error'"
              aria-describedby="newsletter-status"
              class="w-full bg-transparent text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
              @input="status = 'idle'"
            />
            <button
              type="submit"
              class="shrink-0 rounded bg-accent px-4 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-accent-hover"
            >
              Subscribe
            </button>
          </div>

          <p
            id="newsletter-status"
            role="status"
            class="mt-2 h-4 text-xs"
            :class="status === 'error' ? 'text-accent-amber' : 'text-accent-green'"
          >
            <template v-if="status === 'error'">Enter a valid email address.</template>
            <template v-else-if="status === 'done'">Thanks — you're subscribed.</template>
          </p>
        </form>
      </div>
    </div>

    <!-- Guarantees -->
    <div class="border-b border-border-hairline">
      <ul class="mx-auto grid max-w-[1600px] grid-cols-1 sm:grid-cols-3">
        <li
          v-for="(item, index) in guarantees"
          :key="item.label"
          class="flex items-center gap-3 px-4 py-5 md:px-8"
          :class="index > 0 && 'border-t border-border-hairline sm:border-l sm:border-t-0'"
        >
          <component :is="item.icon" class="h-5 w-5 shrink-0 text-accent" aria-hidden="true" />
          <div>
            <p class="text-sm font-medium text-text-primary">{{ item.label }}</p>
            <p class="text-xs text-text-secondary">{{ item.detail }}</p>
          </div>
        </li>
      </ul>
    </div>

    <!-- Photo credits -->
    <div class="border-b border-border-hairline">
      <div class="mx-auto max-w-[1600px] px-4 py-4 md:px-8">
        <button
          type="button"
          class="flex items-center gap-2 text-sm text-text-secondary transition-colors hover:text-text-primary"
          :aria-expanded="showCredits"
          aria-controls="credits-list"
          @click="showCredits = !showCredits"
        >
          <ChevronDown
            class="h-3.5 w-3.5 transition-transform"
            :class="showCredits && 'rotate-180'"
            aria-hidden="true"
          />
          Photography credits ({{ photographers.length }})
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
              class="text-xs text-text-muted transition-colors hover:text-accent"
            >
              {{ credit.photographer }}
            </a>
          </li>
        </ul>
      </div>
    </div>

    <!-- System readout -->
    <div class="mx-auto max-w-[1600px] px-4 py-6 md:px-8">
      <div
        class="flex flex-col gap-3 text-xs text-text-muted md:flex-row md:items-center md:justify-between"
      >
        <p>© {{ YEAR }} NEXUS — demo storefront, not a real retailer.</p>
        <p class="flex flex-wrap gap-x-5 gap-y-1">
          <span>Free delivery over $200</span>
          <span>30-day returns</span>
          <span>Secure checkout</span>
        </p>
      </div>
    </div>
  </footer>
</template>
