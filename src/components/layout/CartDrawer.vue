<script setup lang="ts">
import { computed, ref, toRef } from 'vue'
import { X, Minus, Plus, Trash2, ShieldCheck } from 'lucide-vue-next'
import { useCartStore } from '@/stores/cart'
import { useCurrency } from '@/composables/useCurrency'
import { useFocusTrap } from '@/composables/useFocusTrap'

const cart = useCartStore()
const { format } = useCurrency()

const panel = ref<HTMLElement | null>(null)
useFocusTrap(panel, toRef(cart, 'isOpen'), () => cart.close())

// Freight is free over $200 — shown as a live progress readout because a bag
// that tells you how close you are converts better than one that doesn't.
const FREE_FREIGHT_CENTS = 20000
const freightRemaining = computed(() => Math.max(0, FREE_FREIGHT_CENTS - cart.subtotalCents))
const freightProgress = computed(() =>
  Math.min(100, Math.round((cart.subtotalCents / FREE_FREIGHT_CENTS) * 100)),
)
</script>

<template>
  <Teleport to="body">
    <!-- Scrim -->
    <Transition
      enter-from-class="opacity-0"
      leave-to-class="opacity-0"
      enter-active-class="transition-opacity duration-300"
      leave-active-class="transition-opacity duration-300"
    >
      <div
        v-if="cart.isOpen"
        class="fixed inset-0 z-[60] bg-void/70 backdrop-blur-sm"
        @click="cart.close()"
      />
    </Transition>

    <!-- Panel -->
    <Transition
      enter-from-class="translate-x-full"
      leave-to-class="translate-x-full"
      enter-active-class="transition-transform duration-400 ease-out"
      leave-active-class="transition-transform duration-300 ease-in"
    >
      <aside
        v-if="cart.isOpen"
        ref="panel"
        role="dialog"
        aria-modal="true"
        aria-label="Shopping bag"
        class="fixed inset-y-0 right-0 z-[70] flex w-full max-w-[440px] flex-col border-l border-border-hairline bg-surface-1"
      >
        <!-- Header -->
        <header
          class="flex items-center justify-between border-b border-border-hairline px-5 py-4"
        >
          <div>
            <p class="mono-label">BAG_MANIFEST</p>
            <p class="font-display text-lg font-extrabold uppercase tracking-tighter">
              {{ cart.count }} {{ cart.count === 1 ? 'ITEM' : 'ITEMS' }}
            </p>
          </div>
          <button
            type="button"
            class="border border-border-hairline p-2 text-text-secondary transition-colors hover:border-accent-cyan/50 hover:text-text-primary"
            aria-label="Close shopping bag"
            @click="cart.close()"
          >
            <X class="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        <!-- Free-freight telemetry -->
        <div class="border-b border-border-hairline px-5 py-3">
          <div class="flex items-center justify-between font-mono text-[10px] tracking-[0.14em]">
            <span class="text-text-muted">GLOBAL_EXPRESS_FREIGHT</span>
            <span :class="freightRemaining ? 'text-text-secondary' : 'text-accent-neon'">
              {{ freightRemaining ? `${format(freightRemaining)} TO FREE` : 'UNLOCKED // FREE' }}
            </span>
          </div>
          <div class="mt-2 h-px w-full bg-border-hairline">
            <div
              class="h-px bg-accent-cyan transition-all duration-500"
              :style="{ width: `${freightProgress}%` }"
            />
          </div>
        </div>

        <!-- Lines -->
        <div class="flex-1 overflow-y-auto">
          <p
            v-if="!cart.items.length"
            class="px-5 py-16 text-center font-mono text-xs leading-relaxed tracking-[0.14em] text-text-muted"
          >
            BAG_EMPTY
            <span class="mt-2 block text-text-secondary/60">
              NO HARDWARE SELECTED FOR DISPATCH
            </span>
          </p>

          <ul v-else class="divide-y divide-border-hairline">
            <li v-for="line in cart.items" :key="line.sku" class="flex gap-4 px-5 py-4">
              <img
                :src="line.thumb"
                :alt="line.title"
                width="72"
                height="72"
                loading="lazy"
                class="h-18 w-18 shrink-0 border border-border-hairline bg-surface-2 object-cover"
                style="width: 72px; height: 72px"
              />

              <div class="min-w-0 flex-1">
                <p class="mono-label truncate">{{ line.brand.replace('_', ' ') }}</p>
                <p class="truncate text-sm font-semibold tracking-tight">{{ line.title }}</p>
                <p class="mono-label mt-0.5 text-text-secondary/70">{{ line.sku }}</p>

                <div class="mt-2.5 flex items-center justify-between">
                  <div class="flex items-center border border-border-hairline">
                    <button
                      type="button"
                      class="px-2 py-1 text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
                      :aria-label="`Decrease quantity of ${line.title}`"
                      @click="cart.setQty(line.sku, line.qty - 1)"
                    >
                      <Minus class="h-3 w-3" aria-hidden="true" />
                    </button>
                    <span class="nums w-8 text-center font-mono text-xs">{{ line.qty }}</span>
                    <button
                      type="button"
                      class="px-2 py-1 text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30"
                      :disabled="line.qty >= line.stockCount"
                      :aria-label="`Increase quantity of ${line.title}`"
                      @click="cart.setQty(line.sku, line.qty + 1)"
                    >
                      <Plus class="h-3 w-3" aria-hidden="true" />
                    </button>
                  </div>

                  <div class="flex items-center gap-3">
                    <span class="nums font-mono text-xs text-text-primary">
                      {{ format(line.unitPriceCents * line.qty) }}
                    </span>
                    <button
                      type="button"
                      class="text-text-muted transition-colors hover:text-accent-amber"
                      :aria-label="`Remove ${line.title} from bag`"
                      @click="cart.remove(line.sku)"
                    >
                      <Trash2 class="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </div>

                <p v-if="line.qty >= line.stockCount" class="mono-label mt-1.5 text-accent-amber">
                  MAX_STOCK_REACHED
                </p>
              </div>
            </li>
          </ul>
        </div>

        <!-- Totals -->
        <footer class="border-t border-border-hairline px-5 py-4">
          <div class="flex items-end justify-between gap-4">
            <div class="min-w-0">
              <p class="mono-label">SUBTOTAL</p>
              <p class="mono-label whitespace-nowrap text-text-secondary/60">TAXES AT DISPATCH</p>
            </div>
            <p class="nums shrink-0 font-display text-2xl font-extrabold tracking-tighter">
              {{ format(cart.subtotalCents) }}
            </p>
          </div>

          <button
            type="button"
            disabled
            class="mt-4 flex w-full cursor-not-allowed items-center justify-center gap-2 border border-border-hairline bg-surface-2 px-4 py-3 font-mono text-[11px] tracking-[0.16em] text-text-muted"
          >
            CHECKOUT // PHASE_02
          </button>
          <p class="mono-label mt-2 flex items-center justify-center gap-1.5 text-text-muted">
            <ShieldCheck class="h-3 w-3" aria-hidden="true" />
            ENCRYPTED GATEWAY — NOT WIRED IN THIS BUILD
          </p>
        </footer>
      </aside>
    </Transition>
  </Teleport>
</template>
