<script setup lang="ts">
import { ref, watch } from 'vue'
import { Search, ShoppingBag } from 'lucide-vue-next'
import { useCartStore } from '@/stores/cart'
import { useUiStore, type CurrencyCode } from '@/stores/ui'
import { useCurrency } from '@/composables/useCurrency'

const cart = useCartStore()
const ui = useUiStore()
const { format } = useCurrency()

const links = [
  { id: '01', label: 'BRANDS', href: '#brands' },
  { id: '02', label: 'CATEGORIES', href: '#categories' },
  { id: '03', label: 'FLAGSHIP', href: '#flagship' },
  { id: '04', label: 'DROPS', href: '#drops' },
]

const currencies: CurrencyCode[] = ['USD', 'EUR', 'GBP']

// Pulse the counter whenever the bag changes, so a quick-add from far down the
// page still registers visually up here.
const bumped = ref(false)
watch(
  () => cart.count,
  (next, prev) => {
    if (next <= prev) return
    bumped.value = true
    window.setTimeout(() => (bumped.value = false), 400)
  },
)

const pad = (n: number) => String(n).padStart(2, '0')
</script>

<template>
  <header
    class="fixed inset-x-0 top-0 z-50 h-16 border-b border-border-hairline bg-void/80 backdrop-blur-md"
  >
    <nav class="mx-auto flex h-full max-w-[1800px] items-center justify-between px-4 md:px-8">
      <!-- Logotype + system telemetry -->
      <a href="#top" class="group flex shrink-0 items-center gap-2.5" aria-label="NEXUS home">
        <span class="relative flex h-2 w-2" aria-hidden="true">
          <span
            class="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent-neon opacity-60"
          />
          <span class="relative inline-flex h-2 w-2 rounded-full bg-accent-neon" />
        </span>
        <span class="font-display text-sm font-extrabold uppercase tracking-tighter md:text-base">
          NEXUS<span class="text-text-muted">_//</span><span class="text-accent-cyan">[TECH]</span>
        </span>
        <span class="mono-label hidden lg:inline">SYSTEM_ONLINE</span>
      </a>

      <!-- Catalog jump links -->
      <ul class="hidden items-center gap-1 lg:flex">
        <li v-for="link in links" :key="link.id">
          <a
            :href="link.href"
            class="group flex items-center px-3 py-2 font-mono text-[11px] uppercase tracking-[0.16em] text-text-secondary transition-colors hover:text-text-primary"
          >
            <span class="text-accent-cyan opacity-0 transition-opacity group-hover:opacity-100"
              >[</span
            >
            <span class="text-text-muted">{{ link.id }}_</span>{{ link.label }}
            <span class="text-accent-cyan opacity-0 transition-opacity group-hover:opacity-100"
              >]</span
            >
          </a>
        </li>
      </ul>

      <!-- Commerce tools -->
      <div class="flex items-center gap-2 md:gap-3">
        <button
          type="button"
          class="hidden items-center gap-3 border border-border-hairline bg-surface-1 px-3 py-2 font-mono text-[11px] text-text-secondary transition-colors hover:border-accent-cyan/50 hover:text-text-primary sm:flex"
          aria-label="Search the catalog"
          @click="ui.openSearch()"
        >
          <Search class="h-3.5 w-3.5" aria-hidden="true" />
          <span class="tracking-[0.14em]">SEARCH</span>
          <kbd class="border border-border-hairline px-1.5 py-0.5 text-[10px] text-text-muted">
            ⌘K
          </kbd>
        </button>

        <button
          type="button"
          class="border border-border-hairline bg-surface-1 p-2 text-text-secondary transition-colors hover:border-accent-cyan/50 hover:text-text-primary sm:hidden"
          aria-label="Search the catalog"
          @click="ui.openSearch()"
        >
          <Search class="h-4 w-4" aria-hidden="true" />
        </button>

        <label class="sr-only" for="currency">Display currency</label>
        <select
          id="currency"
          :value="ui.currency"
          class="hidden border border-border-hairline bg-surface-1 px-2 py-2 font-mono text-[11px] tracking-[0.14em] text-text-secondary transition-colors hover:border-accent-cyan/50 focus:text-text-primary md:block"
          @change="ui.setCurrency(($event.target as HTMLSelectElement).value as CurrencyCode)"
        >
          <option v-for="code in currencies" :key="code" :value="code" class="bg-surface-1">
            {{ code }}
          </option>
        </select>

        <button
          type="button"
          data-bag-trigger
          class="flex shrink-0 items-center gap-2.5 whitespace-nowrap border px-2.5 py-2 font-mono text-[11px] tracking-[0.14em] transition-all md:px-3"
          :class="
            cart.count
              ? 'border-accent-cyan/60 bg-accent-cyan/10 text-accent-cyan'
              : 'border-border-hairline bg-surface-1 text-text-secondary hover:border-accent-cyan/50 hover:text-text-primary'
          "
          :aria-label="`Open shopping bag, ${cart.count} items`"
          @click="cart.toggle()"
        >
          <ShoppingBag class="h-3.5 w-3.5" aria-hidden="true" />
          <span class="transition-transform duration-200" :class="bumped && 'scale-125'">
            BAG ({{ pad(cart.count) }})
          </span>
          <span v-if="cart.count" class="nums hidden border-l border-accent-cyan/30 pl-2.5 sm:inline">
            {{ format(cart.subtotalCents) }}
          </span>
        </button>
      </div>
    </nav>
  </header>
</template>
