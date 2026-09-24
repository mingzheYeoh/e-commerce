<script setup lang="ts">
import { computed, ref, toRef } from 'vue'
import { X, Minus, Plus, Trash2, Lock } from 'lucide-vue-next'
import { useRouter } from 'vue-router'
import { useCartStore, lineKey } from '@/stores/cart'
import { useCurrency } from '@/composables/useCurrency'
import { DOMESTIC_FREE_ABOVE } from '@/lib/shipping'
import { useFocusTrap } from '@/composables/useFocusTrap'
import { brandName } from '@/data/brands'

const cart = useCartStore()
const { format } = useCurrency()

const router = useRouter()
const panel = ref<HTMLElement | null>(null)

function toCheckout() {
  cart.close()
  router.push('/checkout')
}
useFocusTrap(panel, toRef(cart, 'isOpen'), () => cart.close())

// Read from the shipping table rather than repeated here: the drawer promising
// one threshold while checkout charged against another is how a storefront ends
// up lying to its customers in a way nobody notices.
const FREE_DELIVERY_CENTS = DOMESTIC_FREE_ABOVE
const remaining = computed(() => Math.max(0, FREE_DELIVERY_CENTS - cart.subtotalCents))
const progress = computed(() =>
  Math.min(100, Math.round((cart.subtotalCents / FREE_DELIVERY_CENTS) * 100)),
)
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-from-class="opacity-0"
      leave-to-class="opacity-0"
      enter-active-class="transition-opacity duration-300"
      leave-active-class="transition-opacity duration-300"
    >
      <div
        v-if="cart.isOpen"
        class="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm"
        @click="cart.close()"
      />
    </Transition>

    <Transition
      enter-from-class="translate-x-full"
      leave-to-class="translate-x-full"
      enter-active-class="transition-transform duration-300 ease-out"
      leave-active-class="transition-transform duration-200 ease-in"
    >
      <aside
        v-if="cart.isOpen"
        ref="panel"
        role="dialog"
        aria-modal="true"
        aria-label="Shopping cart"
        class="fixed inset-y-0 right-0 z-[70] flex w-full max-w-[440px] flex-col border-l border-border-hairline bg-surface-1"
      >
        <header class="flex items-center justify-between border-b border-border-hairline px-5 py-4">
          <h2 class="text-lg font-bold">
            Your cart
            <span class="nums font-normal text-text-secondary">({{ cart.count }})</span>
          </h2>
          <button
            type="button"
            class="rounded p-2 text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
            aria-label="Close cart"
            @click="cart.close()"
          >
            <X class="h-5 w-5" aria-hidden="true" />
          </button>
        </header>

        <div class="border-b border-border-hairline px-5 py-3">
          <p class="flex items-center justify-between text-xs">
            <span class="text-text-secondary">Free US standard delivery</span>
            <span :class="remaining ? 'text-text-secondary' : 'font-medium text-accent-green'">
              {{ remaining ? `${format(remaining)} away` : 'Unlocked' }}
            </span>
          </p>
          <div class="mt-2 h-1 w-full overflow-hidden rounded-full bg-surface-2">
            <div
              class="h-full rounded-full bg-accent transition-all duration-500"
              :style="{ width: `${progress}%` }"
            />
          </div>
        </div>

        <div class="flex-1 overflow-y-auto">
          <div v-if="!cart.items.length" class="px-5 py-16 text-center">
            <p class="font-medium text-text-primary">Your cart is empty</p>
            <p class="mt-1 text-sm text-text-secondary">
              Browse the collection to add your first item.
            </p>
          </div>

          <ul v-else class="divide-y divide-border-hairline">
            <li
              v-for="line in cart.lines"
              :key="lineKey(line)"
              class="flex gap-4 px-5 py-4"
              :class="!line.available && 'opacity-60'"
            >
              <img
                :src="line.thumb"
                :alt="line.title"
                width="72"
                height="72"
                loading="lazy"
                class="shrink-0 rounded border border-border-hairline bg-surface-2 object-cover"
                style="width: 72px; height: 72px"
              />

              <div class="min-w-0 flex-1">
                <p class="text-xs text-text-secondary">{{ brandName(line.brand) }}</p>
                <p class="truncate text-sm font-medium">{{ line.title }}</p>
                <p class="code mt-0.5">{{ line.sku }}</p>
                <p v-if="line.finish" class="mt-0.5 text-xs text-text-secondary">{{ line.finish }}</p>

                <div class="mt-2.5 flex items-center justify-between">
                  <div class="flex items-center rounded border border-border-hairline">
                    <button
                      type="button"
                      class="rounded-l px-2 py-1 text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
                      :aria-label="`Decrease quantity of ${line.title}`"
                      @click="cart.setQty(lineKey(line), line.qty - 1)"
                    >
                      <Minus class="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                    <span class="nums w-8 text-center text-sm">{{ line.qty }}</span>
                    <button
                      type="button"
                      class="rounded-r px-2 py-1 text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30"
                      :disabled="line.qty >= line.stockCount"
                      :aria-label="`Increase quantity of ${line.title}`"
                      @click="cart.setQty(lineKey(line), line.qty + 1)"
                    >
                      <Plus class="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>

                  <div class="flex items-center gap-3">
                    <span v-if="line.available" class="nums text-sm font-medium">
                      {{ format(line.unitPriceCents * line.qty) }}
                    </span>
                    <button
                      type="button"
                      class="rounded p-1 text-text-muted transition-colors hover:text-accent-amber"
                      :aria-label="`Remove ${line.title}`"
                      @click="cart.remove(lineKey(line))"
                    >
                      <Trash2 class="h-4 w-4" aria-hidden="true" />
                    </button>
                  </div>
                </div>

                <p v-if="!line.available" class="mt-1.5 text-xs text-accent-amber">
                  No longer available. Remove it to check out.
                </p>
                <p v-else-if="line.limited" class="mt-1.5 text-xs text-accent-amber">
                  Only {{ line.stockCount }} in stock right now, so {{ line.qty }} will be ordered.
                </p>
                <p v-else-if="line.qty >= line.stockCount" class="mt-1.5 text-xs text-accent-amber">
                  Maximum available quantity
                </p>
              </div>
            </li>
          </ul>
        </div>

        <footer class="border-t border-border-hairline px-5 py-4">
          <div class="flex items-end justify-between gap-4">
            <div>
              <p class="text-sm text-text-secondary">Subtotal</p>
              <p class="text-xs text-text-muted">Taxes calculated at checkout</p>
            </div>
            <p class="nums shrink-0 text-2xl font-bold">{{ format(cart.subtotalCents) }}</p>
          </div>

          <button
            type="button"
            class="btn-primary mt-4 w-full disabled:cursor-not-allowed disabled:opacity-40"
            :disabled="cart.hasUnavailable"
            @click="toCheckout"
          >
            Checkout
          </button>
          <p class="mt-2 flex items-center justify-center gap-1.5 text-xs text-text-muted">
            <Lock class="h-3 w-3" aria-hidden="true" />
            Demo store — no card is charged
          </p>
        </footer>
      </aside>
    </Transition>
  </Teleport>
</template>
