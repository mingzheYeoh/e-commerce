<script setup lang="ts">
import { ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { Search, ShoppingBag, Tag, Sparkles } from 'lucide-vue-next'
import MegaMenu from './MegaMenu.vue'
import { useCartStore } from '@/stores/cart'
import { useUiStore, type CurrencyCode } from '@/stores/ui'
import { useCurrency } from '@/composables/useCurrency'

const cart = useCartStore()
const ui = useUiStore()
const { format } = useCurrency()


const currencies: CurrencyCode[] = ['USD', 'EUR', 'GBP', 'SGD', 'MYR']

// Pulse the counter whenever the bag grows, so an add from far down the page
// still registers up here.
const bumped = ref(false)
watch(
  () => cart.count,
  (next, prev) => {
    if (next <= prev) return
    bumped.value = true
    window.setTimeout(() => (bumped.value = false), 400)
  },
)
</script>

<template>
  <header
    class="fixed inset-x-0 top-0 z-50 h-16 border-b border-border-hairline bg-void/85 backdrop-blur-xl"
  >
    <nav class="mx-auto flex h-full max-w-[1600px] items-center justify-between px-4 md:px-8">
      <RouterLink to="/" class="flex shrink-0 items-center gap-2" aria-label="NEXUS home">
        <span class="font-display text-lg font-extrabold tracking-tight md:text-xl">NEXUS</span>
        <span class="hidden text-xs text-text-muted lg:inline">Consumer Electronics</span>
      </RouterLink>

      <nav class="hidden items-center gap-1 lg:flex" aria-label="Main">
        <MegaMenu />
        <RouterLink
          to="/shop?deal=1"
          class="flex h-10 items-center gap-1.5 rounded px-3 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
        >
          <Tag class="h-3.5 w-3.5" aria-hidden="true" />
          Deals
        </RouterLink>
        <RouterLink
          to="/ask"
          class="flex h-10 items-center gap-1.5 rounded px-3 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
        >
          <Sparkles class="h-3.5 w-3.5" aria-hidden="true" />
          Ask
        </RouterLink>
      </nav>

      <div class="flex items-center gap-2 md:gap-3">
        <button
          type="button"
          class="hidden h-10 items-center gap-2.5 rounded border border-border-hairline bg-surface-1 px-3 text-sm text-text-secondary transition-colors hover:border-border-strong hover:text-text-primary sm:flex"
          aria-label="Search products"
          @click="ui.openSearch()"
        >
          <Search class="h-4 w-4" aria-hidden="true" />
          <span>Search</span>
          <kbd class="rounded border border-border-hairline px-1.5 text-[10px] leading-4 text-text-muted">⌘K</kbd>
        </button>

        <button
          type="button"
          class="flex h-10 w-10 items-center justify-center rounded border border-border-hairline bg-surface-1 text-text-secondary transition-colors hover:text-text-primary sm:hidden"
          aria-label="Search products"
          @click="ui.openSearch()"
        >
          <Search class="h-4 w-4" aria-hidden="true" />
        </button>

        <label class="sr-only" for="currency">Currency</label>
        <select
          id="currency"
          :value="ui.currency"
          class="hidden h-10 rounded border border-border-hairline bg-surface-1 px-2 text-sm text-text-secondary transition-colors hover:border-border-strong md:block"
          @change="ui.setCurrency(($event.target as HTMLSelectElement).value as CurrencyCode)"
        >
          <option v-for="code in currencies" :key="code" :value="code" class="bg-surface-1">
            {{ code }}
          </option>
        </select>

        <button
          type="button"
          class="flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded border px-3 text-sm font-medium transition-all"
          :class="
            cart.count
              ? 'border-accent bg-accent/10 text-accent'
              : 'border-border-hairline bg-surface-1 text-text-secondary hover:border-border-strong hover:text-text-primary'
          "
          :aria-label="`Open cart, ${cart.count} items`"
          @click="cart.toggle()"
        >
          <ShoppingBag class="h-4 w-4" aria-hidden="true" />
          <span class="nums transition-transform duration-200" :class="bumped && 'scale-125'">
            Cart ({{ cart.count }})
          </span>
          <span v-if="cart.count" class="nums hidden border-l border-accent/30 pl-2 sm:inline">
            {{ format(cart.subtotalCents) }}
          </span>
        </button>
      </div>
    </nav>
  </header>
</template>
