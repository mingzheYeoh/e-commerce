<script setup lang="ts">
/**
 * Grounded question answering over the catalogue.
 *
 * The design goal is that a visitor can always tell where an answer came from.
 * Citations are rendered as links to the product they name, sources are listed
 * beneath, and an answer that could not be traced to a retrieved passage is
 * labelled rather than presented with the same confidence as one that could.
 */
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { Sparkles, CornerDownLeft, AlertCircle, Quote } from 'lucide-vue-next'
import { ask, health, type AskResponse } from '@/lib/api'
import { toSegments } from '@/lib/citations'
import { products } from '@/data/products'
import { useCurrency } from '@/composables/useCurrency'

const { formatPrice } = useCurrency()

const question = ref('')
const answer = ref<AskResponse | null>(null)
const pending = ref(false)
const failure = ref<'timeout' | 'offline' | 'error' | null>(null)
const graphOnline = ref<boolean | null>(null)

let inFlight: AbortController | null = null

const EXAMPLES = [
  'How fast does the iPhone 18 Pro charge?',
  'Which products charge at 60W or more?',
  'What is the difference between the XPS 16 and the ThinkPad X1 Carbon?',
  'Which headphones have noise cancellation under $400?',
]

const byId = new Map(products.map((p) => [p.id, p]))

/** Answer text split into prose and linkable citations. See lib/citations.ts. */
const segments = computed(() =>
  toSegments(answer.value?.answer ?? '', (id) => byId.get(id)?.title, answer.value?.citations ?? []),
)

const sources = computed(() =>
  (answer.value?.citations ?? []).map((id) => byId.get(id)).filter((p) => p !== undefined),
)

async function submit() {
  const q = question.value.trim()
  if (!q || pending.value) return

  inFlight?.abort()
  inFlight = new AbortController()

  pending.value = true
  failure.value = null
  answer.value = null

  const result = await ask(q, inFlight.signal)
  pending.value = false

  if (result.ok) answer.value = result.data
  else failure.value = result.reason
}

onMounted(async () => {
  // Reported in the UI because the graph's absence changes what a numeric
  // question can return, and a silent downgrade is worse than a visible one.
  const h = await health()
  graphOnline.value = h ? h.graph : null
})
</script>

<template>
  <section class="mx-auto w-full max-w-3xl">
    <form class="relative" @submit.prevent="submit">
      <label for="ask" class="sr-only">Ask a question about the catalogue</label>
      <div
        class="flex items-center gap-3 rounded-card border border-border-hairline bg-surface-1 px-4 py-3 transition-colors focus-within:border-accent"
      >
        <Sparkles class="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
        <input
          id="ask"
          v-model="question"
          type="text"
          placeholder="Ask about specs, compatibility or comparisons…"
          class="w-full bg-transparent text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
        />
        <button
          type="submit"
          :disabled="!question.trim() || pending"
          class="shrink-0 rounded bg-accent px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-40"
        >
          {{ pending ? 'Thinking…' : 'Ask' }}
        </button>
      </div>
    </form>

    <div v-if="!answer && !pending && !failure" class="mt-4 flex flex-wrap gap-2">
      <button
        v-for="example in EXAMPLES"
        :key="example"
        type="button"
        class="rounded-full border border-border-hairline px-3 py-1.5 text-xs text-text-secondary transition-colors hover:border-border-strong hover:text-text-primary"
        @click="((question = example), submit())"
      >
        {{ example }}
      </button>
    </div>

    <!-- Answer -->
    <div v-if="pending" class="mt-6 space-y-2" aria-live="polite">
      <div class="h-3 w-3/4 animate-pulse rounded bg-surface-2" />
      <div class="h-3 w-full animate-pulse rounded bg-surface-2" />
      <div class="h-3 w-1/2 animate-pulse rounded bg-surface-2" />
    </div>

    <div v-else-if="failure" class="mt-6 flex items-start gap-3 rounded-card border border-border-hairline bg-surface-1 p-4">
      <AlertCircle class="mt-0.5 h-4 w-4 shrink-0 text-accent-amber" aria-hidden="true" />
      <div class="text-sm">
        <p class="font-medium">
          {{
            failure === 'timeout'
              ? 'That took too long.'
              : failure === 'offline'
                ? 'Could not reach the answering service.'
                : 'Something went wrong.'
          }}
        </p>
        <p class="mt-1 text-text-secondary">
          Product search still works — it runs in your browser and does not need this service.
        </p>
      </div>
    </div>

    <div v-else-if="answer" class="mt-6" aria-live="polite">
      <div
        class="rounded-card border p-5"
        :class="
          answer.grounded || answer.refused
            ? 'border-border-hairline bg-surface-1'
            : 'border-accent-amber/30 bg-accent-amber/5'
        "
      >
        <p class="text-[15px] leading-relaxed">
          <template v-for="(seg, i) in segments" :key="i">
            <RouterLink
              v-if="seg.kind === 'cite'"
              :to="`/product/${seg.id}`"
              class="font-medium text-accent underline decoration-accent/40 underline-offset-2 transition-colors hover:decoration-accent"
            >
              {{ seg.title }}
            </RouterLink>
            <template v-else>{{ seg.value }}</template>
          </template>
        </p>

        <!-- A refusal is the system working, so it is not dressed as a warning.
             An answer with no verifiable citation is a different thing. -->
        <p v-if="answer.refused" class="mt-3 text-xs text-text-muted">
          Nothing in the catalogue covers this, so no answer was invented.
        </p>
        <p v-else-if="!answer.grounded" class="mt-3 text-xs text-accent-amber">
          Nothing in this answer could be traced to a catalogue entry, so treat it as unverified.
        </p>
      </div>

      <!-- Sources. A citation a reader cannot open is decoration. -->
      <div v-if="sources.length" class="mt-4">
        <p class="mb-2 flex items-center gap-1.5 text-xs font-medium text-text-secondary">
          <Quote class="h-3 w-3" aria-hidden="true" />
          Answered from
        </p>
        <div class="grid gap-2 sm:grid-cols-2">
          <RouterLink
            v-for="p in sources"
            :key="p.id"
            :to="`/product/${p.id}`"
            class="flex items-center gap-3 rounded border border-border-hairline bg-surface-1 p-2.5 transition-colors hover:border-border-strong"
          >
            <img :src="p.media.thumb" :alt="p.title" width="44" height="44" class="h-11 w-11 shrink-0 rounded object-cover" />
            <span class="min-w-0">
              <span class="block truncate text-sm font-medium">{{ p.title }}</span>
              <span class="nums block text-xs text-text-secondary">{{ formatPrice(p.price) }}</span>
            </span>
          </RouterLink>
        </div>
      </div>
    </div>

    <p class="mt-6 flex items-center gap-2 text-xs text-text-muted">
      <CornerDownLeft class="h-3 w-3" aria-hidden="true" />
      Answers are generated from catalogue specs only.
      <span v-if="graphOnline === false">Graph lookups are offline, so figures may be incomplete.</span>
    </p>
  </section>
</template>
