<script setup lang="ts">
/**
 * The shopping assistant, with its working shown.
 *
 * Every answer carries the tool calls that produced it — which tool, what
 * arguments, what came back. That is the point of the panel rather than a
 * debugging leftover: an assistant that recommends hardware is asking to be
 * trusted, and "here is the query I ran and the rows it returned" is a better
 * argument than a confident tone.
 */
import { computed, nextTick, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { Sparkles, ChevronDown, Wrench, AlertCircle, Send } from 'lucide-vue-next'
import { chat, type AgentStep } from '@/lib/api'
import { toSegments } from '@/lib/citations'
import { products } from '@/data/products'
import { useCurrency } from '@/composables/useCurrency'

const { format } = useCurrency()
const byId = new Map(products.map((p) => [p.id, p]))

interface Turn {
  role: 'user' | 'assistant'
  content: string
  steps?: AgentStep[]
  citations?: string[]
  truncated?: boolean
}

const turns = ref<Turn[]>([])
const draft = ref('')
const pending = ref(false)
const failure = ref<'timeout' | 'offline' | 'error' | null>(null)
const openSteps = ref<Set<number>>(new Set())
const thread = ref<HTMLElement | null>(null)

const OPENERS = [
  'I need a phone that charges at 80W or faster',
  'something for a noisy open-plan office',
  'what can charge my MacBook Pro on a flight?',
  'compare the XPS 16 and the ThinkPad X1 Carbon',
]

/** Only the plain text goes back to the model; tool records stay client-side. */
const history = computed(() =>
  turns.value.map((t) => ({ role: t.role, content: t.content })).slice(-6),
)

const segmentsFor = (text: string, citations: string[] = []) =>
  toSegments(text, (id) => byId.get(id)?.title, citations)

const productsFor = (ids: string[] = []) =>
  ids.map((id) => byId.get(id)).filter((p) => p !== undefined)

/** "filter_products" reads as machinery; this is what it did. */
function describe(step: AgentStep): string {
  const a = step.args ?? {}
  switch (step.tool) {
    case 'search_products':
      return `Searched the catalogue for “${a.query ?? ''}”`
    case 'filter_products': {
      const bounds = [
        a.min !== undefined ? `at least ${a.min}` : '',
        a.max !== undefined ? `at most ${a.max}` : '',
      ]
        .filter(Boolean)
        .join(' and ')
      return `Filtered on ${a.property}${bounds ? `, ${bounds}` : ''}${a.category ? ` in ${a.category}` : ''}`
    }
    case 'compare_products':
      return `Compared ${a.ids ?? ''}`
    case 'find_accessories':
      return `Looked up what pairs with ${a.id ?? ''}`
    default:
      return step.tool
  }
}

function toggle(index: number) {
  const next = new Set(openSteps.value)
  if (next.has(index)) next.delete(index)
  else next.add(index)
  openSteps.value = next
}

async function send(text?: string) {
  const question = (text ?? draft.value).trim()
  if (!question || pending.value) return

  const sent = history.value
  turns.value.push({ role: 'user', content: question })
  draft.value = ''
  failure.value = null
  pending.value = true
  await scrollDown()

  const result = await chat(question, sent)
  pending.value = false

  if (result.ok) {
    turns.value.push({
      role: 'assistant',
      content: result.data.answer,
      steps: result.data.steps,
      citations: result.data.citations,
      truncated: result.data.truncated,
    })
  } else {
    failure.value = result.reason
  }
  await scrollDown()
}

async function scrollDown() {
  await nextTick()
  thread.value?.scrollTo({ top: thread.value.scrollHeight, behavior: 'smooth' })
}
</script>

<template>
  <section class="mx-auto flex w-full max-w-3xl flex-col">
    <div
      v-if="turns.length"
      ref="thread"
      class="max-h-[58vh] space-y-5 overflow-y-auto pr-1"
      aria-live="polite"
    >
      <div v-for="(turn, i) in turns" :key="i">
        <!-- Shopper -->
        <div v-if="turn.role === 'user'" class="flex justify-end">
          <p class="max-w-[85%] rounded-card bg-accent px-4 py-2.5 text-sm text-white">
            {{ turn.content }}
          </p>
        </div>

        <!-- Assistant -->
        <div v-else>
          <div class="rounded-card border border-border-hairline bg-surface-1 p-4">
            <p class="text-[15px] leading-relaxed">
              <template v-for="(seg, j) in segmentsFor(turn.content, turn.citations)" :key="j">
                <RouterLink
                  v-if="seg.kind === 'cite'"
                  :to="`/product/${seg.id}`"
                  class="font-medium text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
                >
                  {{ seg.title }}
                </RouterLink>
                <template v-else>{{ seg.value }}</template>
              </template>
            </p>

            <p v-if="turn.truncated" class="mt-2 text-xs text-accent-amber">
              The assistant reached its step limit and answered from what it had gathered.
            </p>
          </div>

          <!-- The working. Collapsed by default; a shopper who wants it can open it. -->
          <div v-if="turn.steps?.length" class="mt-2">
            <button
              type="button"
              class="flex items-center gap-1.5 text-xs text-text-muted transition-colors hover:text-text-secondary"
              :aria-expanded="openSteps.has(i)"
              @click="toggle(i)"
            >
              <Wrench class="h-3 w-3" aria-hidden="true" />
              {{ turn.steps.length }} {{ turn.steps.length === 1 ? 'lookup' : 'lookups' }}
              <ChevronDown
                class="h-3 w-3 transition-transform"
                :class="openSteps.has(i) && 'rotate-180'"
                aria-hidden="true"
              />
            </button>

            <div v-if="openSteps.has(i)" class="mt-2 space-y-2">
              <div
                v-for="(step, k) in turn.steps"
                :key="k"
                class="rounded border border-border-hairline bg-surface-2/50 p-3"
              >
                <p class="text-xs font-medium text-text-secondary">{{ describe(step) }}</p>
                <pre class="code mt-1.5 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-text-muted">{{ step.result }}</pre>
              </div>
            </div>
          </div>

          <!-- Products it drew on -->
          <div v-if="productsFor(turn.citations).length" class="mt-3 grid gap-2 sm:grid-cols-2">
            <RouterLink
              v-for="p in productsFor(turn.citations)"
              :key="p.id"
              :to="`/product/${p.id}`"
              class="flex items-center gap-3 rounded border border-border-hairline bg-surface-1 p-2.5 transition-colors hover:border-border-strong"
            >
              <img :src="p.media.thumb" :alt="p.title" width="40" height="40" class="h-10 w-10 shrink-0 rounded object-cover" />
              <span class="min-w-0">
                <span class="block truncate text-sm font-medium">{{ p.title }}</span>
                <span class="nums block text-xs text-text-secondary">{{ format(p.priceMinor) }}</span>
              </span>
            </RouterLink>
          </div>
        </div>
      </div>

      <div v-if="pending" class="flex items-center gap-2 text-sm text-text-muted">
        <Sparkles class="h-3.5 w-3.5 animate-pulse text-accent" aria-hidden="true" />
        Looking through the catalogue…
      </div>
    </div>

    <!-- Openers, before the first exchange -->
    <div v-if="!turns.length" class="mb-5">
      <p class="mb-3 text-sm text-text-secondary">
        Ask in your own words. The assistant queries the catalogue rather than recalling it, and
        shows you every lookup it made.
      </p>
      <div class="flex flex-wrap gap-2">
        <button
          v-for="opener in OPENERS"
          :key="opener"
          type="button"
          class="rounded-full border border-border-hairline px-3 py-1.5 text-xs text-text-secondary transition-colors hover:border-border-strong hover:text-text-primary"
          @click="send(opener)"
        >
          {{ opener }}
        </button>
      </div>
    </div>

    <div
      v-if="failure"
      class="mt-4 flex items-start gap-3 rounded-card border border-border-hairline bg-surface-1 p-4 text-sm"
    >
      <AlertCircle class="mt-0.5 h-4 w-4 shrink-0 text-accent-amber" aria-hidden="true" />
      <div>
        <p class="font-medium">
          {{
            failure === 'timeout'
              ? 'The assistant took too long.'
              : failure === 'offline'
                ? 'Could not reach the assistant.'
                : 'Something went wrong.'
          }}
        </p>
        <p class="mt-1 text-text-secondary">
          Search still works — it runs in your browser and does not need this service.
        </p>
      </div>
    </div>

    <form class="mt-5" @submit.prevent="send()">
      <div
        class="flex items-center gap-3 rounded-card border border-border-hairline bg-surface-1 px-4 py-3 focus-within:border-accent"
      >
        <Sparkles class="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
        <label for="chat" class="sr-only">Ask the shopping assistant</label>
        <input
          id="chat"
          v-model="draft"
          type="text"
          :disabled="pending"
          placeholder="What are you looking for?"
          class="w-full bg-transparent text-sm placeholder:text-text-muted focus:outline-none disabled:opacity-50"
        />
        <button
          type="submit"
          :disabled="!draft.trim() || pending"
          class="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-accent text-white transition-colors hover:bg-accent-hover disabled:opacity-40"
          aria-label="Send"
        >
          <Send class="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </form>
  </section>
</template>
