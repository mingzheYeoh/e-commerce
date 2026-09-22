<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, toRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Search, CornerDownLeft, Sparkles } from 'lucide-vue-next'
import { products } from '@/data/products'
import { brandName } from '@/data/brands'
import { recommend } from '@/lib/recommend'
import { ensureReady, hybridSearch, semanticState, type SemanticState } from '@/lib/semantic'
import type { Product } from '@/types'
import { useCartStore } from '@/stores/cart'
import { useUiStore } from '@/stores/ui'
import { useCurrency } from '@/composables/useCurrency'
import { useFocusTrap } from '@/composables/useFocusTrap'

const router = useRouter()
const ui = useUiStore()
const cart = useCartStore()
const { format } = useCurrency()

const panel = ref<HTMLElement | null>(null)
const query = ref('')
const cursor = ref(0)

useFocusTrap(panel, toRef(ui, 'searchOpen'), () => ui.closeSearch())

const EXAMPLES = [
  'headphones for a noisy flight under $500',
  'something to vlog with, around $1000',
  'best gaming mouse',
  'keyboard and mouse for working from home',
]

/**
 * One box, two behaviours. A sentence goes to the recommender, which reads a
 * budget and a use case out of it; a short fragment falls back to plain
 * matching, because "mavic" is a lookup, not a question.
 */
const isSentence = computed(() => query.value.trim().split(/\s+/).length >= 3)

const result = computed(() => recommend(query.value, 6))

const fallback = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return products.slice(0, 6)
  return products
    .filter((p) =>
      `${p.title} ${p.brand} ${p.sku} ${p.specsSummary.join(' ')}`.toLowerCase().includes(q),
    )
    .slice(0, 8)
})

/**
 * Semantic results, when and if the model is ready.
 *
 * The embedding model is a ~23 MB download, so it is fetched on the first
 * sentence a visitor types rather than on page load, and the keyword engine
 * answers in the meantime. Results improve a moment later instead of the
 * shopper watching a spinner — and if the model never arrives (offline, blocked
 * CDN, old browser) nothing is broken, the keyword answer simply stands.
 */
const enhanced = ref<Product[] | null>(null)
const engine = ref<SemanticState>('idle')
let latest = 0

watch(
  [query, isSentence],
  async () => {
    enhanced.value = null
    if (!isSentence.value) return

    const token = ++latest
    void ensureReady().then(() => {
      engine.value = semanticState()
    })

    const { products: hits, semantic } = await hybridSearch(query.value, 6)
    // A slower earlier query must not overwrite a newer one's results.
    if (token !== latest || !semantic) return
    enhanced.value = hits
    engine.value = semanticState()
  },
  { flush: 'post' },
)

const rows = computed(() => {
  if (enhanced.value?.length) {
    // Reasons come from the keyword engine, so carry over whichever it explained.
    const why = new Map(result.value.items.map((r) => [r.product.id, r.reasons]))
    return enhanced.value.map((product) => ({ product, reasons: why.get(product.id) ?? [] }))
  }
  return isSentence.value && result.value.items.length
    ? result.value.items
    : fallback.value.map((product) => ({ product, reasons: [] as string[] }))
})

const understood = computed(() => (isSentence.value ? result.value.understood : []))

watch(query, () => (cursor.value = 0))
watch(
  () => ui.searchOpen,
  (open) => {
    if (open) {
      query.value = ''
      cursor.value = 0
    }
  },
)

function open(id: string) {
  router.push(`/product/${id}`)
  ui.closeSearch()
}

function onKeydown(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    ui.toggleSearch()
    return
  }
  if (!ui.searchOpen) return

  const count = Math.max(rows.value.length, 1)
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    cursor.value = (cursor.value + 1) % count
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    cursor.value = (cursor.value - 1 + count) % count
  } else if (event.key === 'Enter') {
    const picked = rows.value[cursor.value]
    if (picked) {
      event.preventDefault()
      open(picked.product.id)
    }
  }
}

onMounted(() => document.addEventListener('keydown', onKeydown))
onUnmounted(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-from-class="opacity-0"
      leave-to-class="opacity-0"
      enter-active-class="transition-opacity duration-200"
      leave-active-class="transition-opacity duration-150"
    >
      <div
        v-if="ui.searchOpen"
        class="fixed inset-0 z-[80] flex items-start justify-center bg-black/70 px-4 pt-[10vh] backdrop-blur-sm"
        @click.self="ui.closeSearch()"
      >
        <div
          ref="panel"
          role="dialog"
          aria-modal="true"
          aria-label="Product search"
          class="w-full max-w-2xl overflow-hidden rounded-card border border-border-hairline bg-surface-1 shadow-2xl shadow-black/60"
        >
          <div class="flex items-center gap-3 border-b border-border-hairline px-4 py-3.5">
            <Search class="h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
            <input
              v-model="query"
              type="text"
              placeholder="Search, or describe what you need…"
              aria-label="Search products, or describe what you need"
              class="w-full bg-transparent text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
            />
            <kbd
              class="shrink-0 rounded border border-border-hairline px-1.5 text-[10px] leading-4 text-text-muted"
            >
              Esc
            </kbd>
          </div>

          <!-- What the recommender pulled out of the sentence. Showing this is
               the difference between trusting the results and wondering why a
               drone came back — and it makes the seam visible when it
               understood nothing. -->
          <div
            v-if="understood.length || engine !== 'idle'"
            class="flex flex-wrap items-center gap-2 border-b border-border-hairline bg-accent/5 px-4 py-2.5"
          >
            <Sparkles class="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
            <span v-if="understood.length" class="text-xs text-text-secondary">Looking for</span>
            <span
              v-for="item in understood"
              :key="item"
              class="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent"
            >
              {{ item }}
            </span>

            <!-- Which engine answered. A shopper does not need the word
                 "embeddings", but they do benefit from knowing the results just
                 changed under them, and it makes the degraded path honest
                 rather than silent. -->
            <span
              v-if="engine !== 'idle'"
              class="ml-auto shrink-0 text-[11px] text-text-muted"
              :title="`Query embedded on-device with all-MiniLM-L6-v2; no query leaves the browser`"
            >
              <template v-if="engine === 'loading'">loading semantic model…</template>
              <template v-else-if="engine === 'ready'">keyword + semantic</template>
              <template v-else>keyword only — model unavailable</template>
            </span>
          </div>

          <ul
            v-if="rows.length"
            class="max-h-[46vh] divide-y divide-border-hairline overflow-y-auto"
          >
            <li v-for="(row, index) in rows" :key="row.product.id">
              <div
                class="flex w-full items-center gap-3 px-4 py-3 transition-colors"
                :class="index === cursor ? 'bg-surface-2' : 'hover:bg-surface-2/60'"
                @mouseenter="cursor = index"
              >
                <button
                  type="button"
                  class="flex min-w-0 flex-1 items-center gap-3 text-left"
                  @click="open(row.product.id)"
                >
                  <img
                    :src="row.product.media.thumb"
                    :alt="row.product.title"
                    width="44"
                    height="44"
                    loading="lazy"
                    class="h-11 w-11 shrink-0 rounded border border-border-hairline object-cover"
                  />
                  <span class="min-w-0 flex-1">
                    <span class="block text-xs text-text-secondary">
                      {{ brandName(row.product.brand) }}
                    </span>
                    <span class="block truncate text-sm font-medium">{{ row.product.title }}</span>
                    <span v-if="row.reasons.length" class="block truncate text-xs text-accent">
                      {{ row.reasons[0] }}
                    </span>
                  </span>
                  <span class="nums shrink-0 text-sm font-medium">
                    {{ format(row.product.priceMinor) }}
                  </span>
                </button>

                <button
                  type="button"
                  class="shrink-0 rounded bg-surface-2 px-2.5 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-accent hover:text-white"
                  :aria-label="`Add ${row.product.title} to cart`"
                  @click="cart.add(row.product)"
                >
                  Add
                </button>
                <CornerDownLeft
                  v-if="index === cursor"
                  class="h-3.5 w-3.5 shrink-0 text-accent"
                  aria-hidden="true"
                />
              </div>
            </li>
          </ul>

          <div v-else class="px-4 py-8 text-center">
            <p class="text-sm text-text-secondary">
              Nothing matched. Try describing what you need:
            </p>
            <div class="mt-3 flex flex-wrap justify-center gap-2">
              <button
                v-for="example in EXAMPLES"
                :key="example"
                type="button"
                class="rounded-full border border-border-hairline px-3 py-1 text-xs text-text-secondary transition-colors hover:border-accent hover:text-accent"
                @click="query = example"
              >
                {{ example }}
              </button>
            </div>
          </div>

          <footer
            class="flex items-center gap-4 border-t border-border-hairline px-4 py-2.5 text-xs text-text-muted"
          >
            <span>↑↓ to navigate</span>
            <span>↵ to open</span>
            <span class="nums ml-auto">{{ rows.length }} results</span>
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
