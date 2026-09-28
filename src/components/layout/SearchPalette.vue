<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, toRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  Search,
  CornerDownLeft,
  Sparkles,
  Clock,
  TrendingUp,
  Smartphone,
  Headphones,
  Keyboard,
  Camera,
  Laptop,
  LayoutGrid,
} from 'lucide-vue-next'
import { catalogue } from '@/stores/catalog'
import { brands, brandName } from '@/data/brands'
import { categories } from '@/data/categories'
import { recommend } from '@/lib/recommend'
import { ensureReady, hybridSearch, semanticState, type SemanticState } from '@/lib/semantic'
import {
  clearRecent,
  flatten,
  groupResults,
  numbered,
  popular,
  pushRecent,
  readRecent,
  rowTarget,
  step,
  type PaletteGroup,
  type PaletteRow,
} from '@/lib/palette'
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
const input = ref<HTMLInputElement | null>(null)
const list = ref<HTMLElement | null>(null)
const query = ref('')
const cursor = ref(0)
const recent = ref<string[]>([])

useFocusTrap(panel, toRef(ui, 'searchOpen'), () => ui.closeSearch())

const EXAMPLES = [
  'headphones for a noisy flight under $500',
  'something to vlog with, around $1000',
  'best gaming mouse',
  'keyboard and mouse for working from home',
]

const CATEGORY_ICONS = {
  phones: Smartphone,
  audio: Headphones,
  peripherals: Keyboard,
  imaging: Camera,
  computing: Laptop,
} as const

/**
 * One box, two behaviours. A sentence goes to the recommender, which reads a
 * budget and a use case out of it; a short fragment falls back to plain
 * matching, because "mavic" is a lookup, not a question.
 */
const isSentence = computed(() => query.value.trim().split(/\s+/).length >= 3)

const result = computed(() => recommend(query.value, 6))

const fallback = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return []
  return catalogue.value
    .filter((p) =>
      `${p.title} ${p.brand} ${p.sku} ${p.specsSummary.join(' ')}`.toLowerCase().includes(q),
    )
    .slice(0, 6)
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

const productRows = computed(() => {
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

/** Blank input: recent searches, then popular picks. Otherwise, grouped results. */
const groups = computed<PaletteGroup[]>(() =>
  query.value.trim()
    ? groupResults(query.value, productRows.value, categories, brands)
    : numbered([
        ['Recent', recent.value.map((q) => ({ kind: 'recent' as const, query: q }))],
        [
          'Popular',
          popular(catalogue.value, 3).map((product) => ({
            kind: 'product' as const,
            product,
            reasons: [],
          })),
        ],
      ]),
)

const flat = computed(() => flatten(groups.value))
const nothingFound = computed(() => !!query.value.trim() && flat.value.every((r) => r.kind === 'ask'))

watch(query, () => (cursor.value = 0))
watch(
  () => ui.searchOpen,
  (open) => {
    if (open) {
      query.value = ''
      cursor.value = 0
      recent.value = readRecent()
    } else {
      indicator.value = null
      glide.value = false
    }
  },
)

function activate(row: PaletteRow | undefined) {
  if (!row) return
  if (row.kind === 'recent') {
    query.value = row.query
    input.value?.focus()
    return
  }
  recent.value = pushRecent(query.value)
  router.push(rowTarget(row)!)
  ui.closeSearch()
}

function fill(text: string) {
  query.value = text
  input.value?.focus()
}

function forget() {
  clearRecent()
  recent.value = []
  input.value?.focus()
}

/*
 * One highlight for the whole list, moved to whichever row is selected. It
 * lives inside the scrolling list so it scrolls with the rows, and is measured
 * with offset* (layout box) rather than getBoundingClientRect, which the
 * panel's opening scale would distort. Under reduced motion the global kill
 * switch zeroes its transition, so it jumps instead of sliding.
 */
const indicator = ref<{ x: number; y: number; w: number; h: number } | null>(null)
const glide = ref(false)
let byKeyboard = false

async function place() {
  await nextTick()
  const el = list.value?.querySelector<HTMLElement>(`[data-index="${cursor.value}"]`)
  if (!el) {
    indicator.value = null
    return
  }
  const first = !indicator.value
  indicator.value = { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight }
  // The first placement appears in place; only later moves slide.
  if (first) requestAnimationFrame(() => (glide.value = true))
  if (byKeyboard) el.scrollIntoView?.({ block: 'nearest' })
  byKeyboard = false
}

watch([cursor, flat, () => ui.searchOpen], place)

function point(index: number) {
  if (cursor.value !== index) cursor.value = index
}

function onKeydown(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    ui.toggleSearch()
    return
  }
  if (!ui.searchOpen) return

  const count = flat.value.length
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    byKeyboard = true
    cursor.value = step(cursor.value, event.key === 'ArrowDown' ? 1 : -1, count)
  } else if (event.key === 'Enter') {
    // A focused button (Add, a chip, Clear) does its own thing on Enter.
    if (event.target instanceof HTMLButtonElement) return
    const picked = flat.value[cursor.value]
    if (picked) {
      event.preventDefault()
      activate(picked)
    }
  }
}

onMounted(() => document.addEventListener('keydown', onKeydown))
onUnmounted(() => document.removeEventListener('keydown', onKeydown))

const productCount = computed(() => flat.value.filter((r) => r.kind === 'product').length)
</script>

<template>
  <Teleport to="body">
    <Transition name="palette">
      <div
        v-if="ui.searchOpen"
        class="fixed inset-0 z-[80] flex items-start justify-center bg-black/60 px-4 pt-[10vh] backdrop-blur-[6px]"
        data-lenis-prevent
        @click.self="ui.closeSearch()"
      >
        <div
          ref="panel"
          role="dialog"
          aria-modal="true"
          aria-label="Product search"
          class="palette-panel palette-glow relative w-full max-w-[680px] rounded-2xl border border-white/[0.08] bg-surface-1/95 backdrop-blur-xl"
        >
          <div class="flex h-14 items-center gap-3 border-b border-white/[0.06] px-5">
            <Search class="h-[18px] w-[18px] shrink-0 text-text-secondary" aria-hidden="true" />
            <input
              ref="input"
              v-model="query"
              type="text"
              placeholder="Search products, brands, or describe what you need…"
              aria-label="Search products, or describe what you need"
              class="w-full bg-transparent text-base text-text-primary caret-accent placeholder:text-text-muted focus:outline-none focus-visible:ring-0 md:text-[17px]"
            />
            <kbd class="keycap shrink-0">Esc</kbd>
          </div>

          <!-- What the recommender pulled out of the sentence. Showing this is
               the difference between trusting the results and wondering why a
               drone came back — and it makes the seam visible when it
               understood nothing. -->
          <div
            v-if="understood.length || engine !== 'idle'"
            class="flex flex-wrap items-center gap-2 border-b border-white/[0.06] bg-accent/[0.04] px-5 py-2"
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

          <div
            ref="list"
            class="relative max-h-[min(58vh,540px)] overflow-y-auto overscroll-contain p-2"
          >
            <!-- The sliding highlight -->
            <div
              v-if="indicator"
              class="pointer-events-none absolute left-0 top-0 rounded-lg bg-white/[0.06] ring-1 ring-inset ring-white/[0.06]"
              :class="glide && 'transition-[transform,width,height] duration-200 ease-[cubic-bezier(0.2,0.8,0.2,1)]'"
              :style="{
                transform: `translate(${indicator.x}px, ${indicator.y}px)`,
                width: `${indicator.w}px`,
                height: `${indicator.h}px`,
              }"
              aria-hidden="true"
            >
              <span
                class="absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-full bg-accent shadow-[0_0_8px_rgba(10,132,255,0.8)]"
              />
            </div>

            <p v-if="nothingFound" class="px-3 pb-1 pt-3 text-sm text-text-secondary">
              No products match “{{ query.trim() }}”. Ask the assistant, or try describing it:
            </p>

            <!-- Trending, on a blank input and when nothing matched -->
            <section v-if="!query.trim() || nothingFound" aria-label="Trending searches" class="px-3 pb-2 pt-3">
              <p v-if="!nothingFound" class="group-label mb-2 flex items-center gap-1.5 px-0">
                <TrendingUp class="h-3 w-3" aria-hidden="true" /> Trending
              </p>
              <div class="flex flex-wrap gap-1.5">
                <button
                  v-for="example in EXAMPLES"
                  :key="example"
                  type="button"
                  class="rounded-full border border-white/[0.08] bg-white/[0.02] px-3 py-1 text-xs text-text-secondary transition-colors hover:border-accent/50 hover:text-text-primary"
                  @click="fill(example)"
                >
                  {{ example }}
                </button>
              </div>
            </section>

            <section v-for="group in groups" :key="group.label" :aria-label="group.label">
              <div class="flex items-center justify-between">
                <p class="group-label">{{ group.label }}</p>
                <button
                  v-if="group.label === 'Recent'"
                  type="button"
                  class="mr-3 mt-2 text-[11px] text-text-muted transition-colors hover:text-text-primary"
                  @click="forget"
                >
                  Clear
                </button>
              </div>

              <!-- Popular: three small cards -->
              <ul v-if="group.label === 'Popular'" class="grid grid-cols-3 gap-1">
                <li v-for="(row, i) in group.rows" :key="i">
                  <button
                    v-if="row.kind === 'product'"
                    type="button"
                    :data-index="group.start + i"
                    class="relative flex w-full flex-col gap-2 rounded-lg p-2.5 text-left"
                    @pointermove="point(group.start + i)"
                    @click="activate(row)"
                  >
                    <img
                      :src="row.product.media.thumb"
                      :alt="row.product.title"
                      width="160"
                      height="120"
                      loading="lazy"
                      class="aspect-[4/3] w-full rounded-md border border-white/[0.06] bg-surface-2 object-cover"
                    />
                    <span class="min-w-0">
                      <span class="block truncate text-xs font-medium text-text-primary">
                        {{ row.product.title }}
                      </span>
                      <span class="nums block text-[11px] text-text-muted">
                        {{ format(row.product.priceMinor) }}
                      </span>
                    </span>
                  </button>
                </li>
              </ul>

              <ul v-else>
                <li v-for="(row, i) in group.rows" :key="i">
                  <!-- Product: open on the row, add from the button -->
                  <div
                    v-if="row.kind === 'product'"
                    :data-index="group.start + i"
                    class="group relative flex items-center gap-3 rounded-lg px-3 py-2"
                    @pointermove="point(group.start + i)"
                  >
                    <button
                      type="button"
                      class="flex min-w-0 flex-1 items-center gap-3 text-left"
                      @click="activate(row)"
                    >
                      <img
                        :src="row.product.media.thumb"
                        :alt="row.product.title"
                        width="40"
                        height="40"
                        loading="lazy"
                        class="h-10 w-10 shrink-0 rounded-md border border-white/[0.06] bg-surface-2 object-cover"
                      />
                      <span class="min-w-0 flex-1">
                        <span class="block truncate text-sm font-medium text-text-primary">
                          {{ row.product.title }}
                        </span>
                        <span class="block truncate text-xs text-text-muted">
                          {{ brandName(row.product.brand) }}
                          <template v-if="row.reasons.length">
                            · <span class="text-accent">{{ row.reasons[0] }}</span>
                          </template>
                        </span>
                      </span>
                      <span class="nums shrink-0 text-sm text-text-secondary">
                        {{ format(row.product.priceMinor) }}
                      </span>
                    </button>

                    <button
                      type="button"
                      class="shrink-0 rounded-md border border-white/[0.08] bg-surface-2 px-2.5 py-1 text-xs font-medium text-text-secondary transition-[opacity,background-color,color] hover:border-accent hover:bg-accent hover:text-white focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                      :class="group.start + i === cursor ? 'opacity-100' : 'opacity-0'"
                      :aria-label="`Add ${row.product.title} to cart`"
                      @click="cart.add(row.product)"
                    >
                      Add
                    </button>
                    <CornerDownLeft
                      class="h-3.5 w-3.5 shrink-0 text-text-muted"
                      :class="group.start + i === cursor ? 'opacity-100' : 'opacity-0'"
                      aria-hidden="true"
                    />
                  </div>

                  <!-- Category, brand, recent search, Ask AI -->
                  <button
                    v-else
                    type="button"
                    :data-index="group.start + i"
                    class="relative flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left"
                    @pointermove="point(group.start + i)"
                    @click="activate(row)"
                  >
                    <template v-if="row.kind === 'category'">
                      <span class="tile">
                        <component
                          :is="CATEGORY_ICONS[row.category.id] ?? LayoutGrid"
                          class="h-4 w-4 text-text-secondary"
                          aria-hidden="true"
                        />
                      </span>
                      <span class="min-w-0 flex-1">
                        <span class="block truncate text-sm font-medium text-text-primary">
                          {{ row.category.label }}
                        </span>
                        <span class="block truncate text-xs text-text-muted">{{ row.category.blurb }}</span>
                      </span>
                    </template>

                    <template v-else-if="row.kind === 'brand'">
                      <span
                        class="tile text-[11px] font-semibold"
                        :style="{ color: row.brand.accent, backgroundColor: `${row.brand.accent}14` }"
                      >
                        {{ row.brand.name.slice(0, 2) }}
                      </span>
                      <span class="min-w-0 flex-1">
                        <span class="block truncate text-sm font-medium text-text-primary">
                          {{ row.brand.name }}
                        </span>
                        <span class="block truncate text-xs text-text-muted">{{ row.brand.tagline }}</span>
                      </span>
                      <span class="nums shrink-0 text-xs text-text-muted">
                        {{ row.brand.productCount }} products
                      </span>
                    </template>

                    <template v-else-if="row.kind === 'recent'">
                      <Clock class="mx-2.5 h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
                      <span class="min-w-0 flex-1 truncate text-sm text-text-secondary">{{ row.query }}</span>
                    </template>

                    <template v-else-if="row.kind === 'ask'">
                      <span class="tile !border-accent/30 bg-gradient-to-br from-accent/30 to-accent/[0.04]">
                        <Sparkles class="h-4 w-4 text-accent" aria-hidden="true" />
                      </span>
                      <span class="min-w-0 flex-1">
                        <span class="block truncate text-sm font-medium text-text-primary">
                          Ask AI: <span class="text-accent-hover">“{{ row.query }}”</span>
                        </span>
                        <span class="block truncate text-xs text-text-muted">
                          A cited answer from the catalogue assistant
                        </span>
                      </span>
                    </template>

                    <CornerDownLeft
                      class="h-3.5 w-3.5 shrink-0 text-text-muted"
                      :class="group.start + i === cursor ? 'opacity-100' : 'opacity-0'"
                      aria-hidden="true"
                    />
                  </button>
                </li>
              </ul>
            </section>
          </div>

          <footer
            class="flex items-center gap-4 border-t border-white/[0.06] px-4 py-2.5 text-[11px] text-text-muted"
          >
            <span class="flex items-center gap-1.5">
              <kbd class="keycap">↑</kbd><kbd class="keycap">↓</kbd> Navigate
            </span>
            <span class="flex items-center gap-1.5"><kbd class="keycap">↵</kbd> Open</span>
            <span class="hidden items-center gap-1.5 sm:flex"><kbd class="keycap">Esc</kbd> Close</span>
            <span v-if="query.trim()" class="nums ml-auto">{{ productCount }} results</span>
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* Scoped to the palette so the storefront's main.css stays untouched. */
.keycap {
  @apply inline-flex h-5 min-w-5 items-center justify-center rounded border border-white/10 border-b-white/[0.18] bg-white/[0.04] px-1.5 font-sans text-[10px] font-medium leading-none text-text-secondary;
}

.group-label {
  @apply px-3 pb-1 pt-3 text-[11px] font-medium uppercase tracking-[0.08em] text-text-muted;
}

.tile {
  @apply grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-white/[0.08] bg-surface-2;
}

/* Open: the backdrop fades while the panel scales up from just below full
   size. The kill switch in main.css zeroes both under reduced motion. */
.palette-enter-active,
.palette-leave-active {
  transition: opacity 180ms ease;
}
.palette-enter-active .palette-panel {
  transition:
    transform 260ms cubic-bezier(0.16, 1, 0.3, 1),
    opacity 180ms ease;
}
.palette-leave-active .palette-panel {
  transition:
    transform 120ms ease-in,
    opacity 120ms ease-in;
}
.palette-enter-from,
.palette-leave-to {
  opacity: 0;
}
.palette-enter-from .palette-panel,
.palette-leave-to .palette-panel {
  opacity: 0;
  transform: translateY(-8px) scale(0.97);
}

.palette-panel {
  box-shadow:
    0 0 0 1px rgba(0, 0, 0, 0.5),
    0 32px 80px -16px rgba(0, 0, 0, 0.85),
    0 0 90px -30px rgba(10, 132, 255, 0.35);
}

/* A faint arc of accent light travelling round the panel edge: a conic
   gradient masked down to the 1px border. Browsers without @property see it
   standing still, which is fine. */
@property --palette-angle {
  syntax: '<angle>';
  initial-value: 0deg;
  inherits: false;
}

.palette-glow::before {
  content: '';
  position: absolute;
  inset: -1px;
  padding: 1px;
  border-radius: inherit;
  background: conic-gradient(
    from var(--palette-angle),
    transparent 0deg,
    transparent 210deg,
    rgba(10, 132, 255, 0.55) 290deg,
    rgba(64, 156, 255, 0.2) 330deg,
    transparent 360deg
  );
  -webkit-mask:
    linear-gradient(#000 0 0) content-box,
    linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  pointer-events: none;
  animation: palette-spin 7s linear infinite;
}

@keyframes palette-spin {
  to {
    --palette-angle: 360deg;
  }
}

/* Reduced motion: a still, even edge rather than a frozen arc. */
[data-motion='reduced'] .palette-glow::before {
  animation: none;
  background: rgba(10, 132, 255, 0.18);
}
</style>
