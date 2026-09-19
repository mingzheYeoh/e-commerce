<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, toRef, watch } from 'vue'
import { Search, CornerDownLeft } from 'lucide-vue-next'
import { products } from '@/data/products'
import { useCartStore } from '@/stores/cart'
import { useUiStore } from '@/stores/ui'
import { useCurrency } from '@/composables/useCurrency'
import { useFocusTrap } from '@/composables/useFocusTrap'

const ui = useUiStore()
const cart = useCartStore()
const { formatPrice } = useCurrency()

const panel = ref<HTMLElement | null>(null)
const query = ref('')
const cursor = ref(0)

useFocusTrap(panel, toRef(ui, 'searchOpen'), () => ui.closeSearch())

/**
 * People search for the object, not our taxonomy: "drone", not "imaging", and
 * "keyboard", not "KEYCHRON". Nothing in a product's own fields carries those
 * words, so each category contributes its everyday synonyms to the haystack.
 */
const CATEGORY_TERMS: Record<string, string> = {
  audio: 'audio acoustics sound headphones earbuds speaker monitor synth synthesizer recorder',
  peripherals: 'peripherals keyboard keycaps switches mouse controller deck input',
  imaging: 'imaging drone quadcopter aerial camera gimbal lens photography video',
  computing: 'computing wearable vr xr spatial headset phone smartphone ring watch biometrics',
}

const haystack = (p: (typeof products)[number]) =>
  `${p.title} ${p.brand} ${p.category} ${p.sku} ${p.specsSummary.join(' ')} ${
    CATEGORY_TERMS[p.category] ?? ''
  }`.toLowerCase()

const results = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return products.slice(0, 6)
  return products.filter((p) => haystack(p).includes(q)).slice(0, 8)
})

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

function onKeydown(event: KeyboardEvent) {
  // ⌘K / Ctrl+K opens from anywhere on the page.
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    ui.toggleSearch()
    return
  }
  if (!ui.searchOpen) return

  if (event.key === 'ArrowDown') {
    event.preventDefault()
    cursor.value = (cursor.value + 1) % Math.max(results.value.length, 1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    cursor.value = (cursor.value - 1 + results.value.length) % Math.max(results.value.length, 1)
  } else if (event.key === 'Enter') {
    const picked = results.value[cursor.value]
    if (picked) {
      event.preventDefault()
      cart.add(picked)
      ui.closeSearch()
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
        class="fixed inset-0 z-[80] flex items-start justify-center bg-void/80 px-4 pt-[12vh] backdrop-blur-sm"
        @click.self="ui.closeSearch()"
      >
        <div
          ref="panel"
          role="dialog"
          aria-modal="true"
          aria-label="Catalog search"
          class="w-full max-w-2xl border border-border-hairline bg-surface-1 shadow-2xl shadow-black/60"
        >
          <!-- Terminal-style input line -->
          <div class="flex items-center gap-3 border-b border-border-hairline px-4 py-3.5">
            <Search class="h-4 w-4 shrink-0 text-accent-cyan" aria-hidden="true" />
            <span class="mono-label shrink-0 text-accent-cyan">QUERY:</span>
            <input
              v-model="query"
              type="text"
              placeholder="hardware, brand or SKU_"
              aria-label="Search the catalog"
              class="w-full bg-transparent font-mono text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
            />
            <kbd class="mono-label shrink-0 border border-border-hairline px-1.5 py-0.5">ESC</kbd>
          </div>

          <!-- Results -->
          <ul v-if="results.length" class="max-h-[50vh] divide-y divide-border-hairline overflow-y-auto">
            <li v-for="(item, index) in results" :key="item.id">
              <button
                type="button"
                class="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors"
                :class="index === cursor ? 'bg-surface-2' : 'hover:bg-surface-2/60'"
                @mouseenter="cursor = index"
                @click="
                  () => {
                    cart.add(item)
                    ui.closeSearch()
                  }
                "
              >
                <img
                  :src="item.media.thumb"
                  :alt="item.title"
                  width="44"
                  height="44"
                  loading="lazy"
                  class="h-11 w-11 shrink-0 border border-border-hairline object-cover"
                />
                <span class="min-w-0 flex-1">
                  <span class="mono-label block">{{ item.brand.replace('_', ' ') }}</span>
                  <span class="block truncate text-sm font-medium tracking-tight">
                    {{ item.title }}
                  </span>
                </span>
                <span class="nums shrink-0 font-mono text-xs text-text-secondary">
                  {{ formatPrice(item.price) }}
                </span>
                <CornerDownLeft
                  v-if="index === cursor"
                  class="h-3.5 w-3.5 shrink-0 text-accent-cyan"
                  aria-hidden="true"
                />
              </button>
            </li>
          </ul>

          <p v-else class="px-4 py-10 text-center font-mono text-xs tracking-[0.14em] text-text-muted">
            NO_MATCH // TRY "DRONE", "KEYBOARD", "SONY"
          </p>

          <footer
            class="flex items-center gap-4 border-t border-border-hairline px-4 py-2.5 font-mono text-[10px] tracking-[0.12em] text-text-muted"
          >
            <span>↑↓ NAVIGATE</span>
            <span>⏎ ADD TO BAG</span>
            <span class="ml-auto">{{ results.length }} RESULT(S)</span>
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
