<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { Minus, Plus, X, ShoppingBag } from 'lucide-vue-next'
import { useCartStore, lineKey } from '@/stores/cart'
import { useCurrency } from '@/composables/useCurrency'
import { DOMESTIC_FREE_ABOVE } from '@/lib/shipping'

const cart = useCartStore()
const router = useRouter()
const { format } = useCurrency()

/** How much more earns free standard delivery, or null once it is earned. */
const toFreeShipping = computed(() => {
  const threshold = DOMESTIC_FREE_ABOVE
  const gap = threshold - cart.subtotalCents
  return gap > 0 ? gap : null
})
</script>

<template>
  <div class="pt-16">
    <div class="mx-auto max-w-[1600px] px-4 py-10 md:px-8 md:py-14">
      <nav class="mb-8 text-sm text-text-secondary" aria-label="Breadcrumb">
        <RouterLink to="/" class="transition-colors hover:text-text-primary">Home</RouterLink>
        <span class="mx-2 text-text-muted">/</span>
        <span class="text-text-primary">Cart</span>
      </nav>

      <h1 class="mb-8 text-3xl font-bold md:text-4xl">Your cart</h1>

      <!-- Empty -->
      <div v-if="!cart.items.length" class="rounded-card border border-border-hairline bg-surface-1 p-10 text-center">
        <ShoppingBag class="mx-auto h-8 w-8 text-text-muted" aria-hidden="true" />
        <p class="mt-4 font-medium">Your cart is empty</p>
        <p class="mt-1 text-sm text-text-secondary">Nothing here yet — the catalogue is a good place to start.</p>
        <RouterLink to="/shop" class="btn-primary mt-6 inline-flex">Browse products</RouterLink>
      </div>

      <div v-else class="grid gap-8 lg:grid-cols-[1fr_340px]">
        <div>
          <p
            v-if="toFreeShipping"
            class="mb-4 rounded-card border border-border-hairline bg-surface-1 px-4 py-3 text-sm"
          >
            Add <span class="nums font-medium text-accent">{{ format(toFreeShipping) }}</span> more
            for free standard delivery in the US.
          </p>

          <ul class="divide-y divide-border-hairline rounded-card border border-border-hairline bg-surface-1">
            <li
              v-for="line in cart.lines"
              :key="lineKey(line)"
              class="flex items-center gap-4 p-4"
              :class="!line.available && 'opacity-60'"
            >
              <img :src="line.thumb" :alt="line.title" width="72" height="72" class="h-18 w-18 shrink-0 rounded object-cover" />

              <div class="min-w-0 flex-1">
                <p class="truncate font-medium">{{ line.title }}</p>
                <p class="code mt-0.5 text-xs text-text-muted">{{ line.sku }}</p>
                <p v-if="line.finish" class="mt-0.5 text-xs text-text-secondary">{{ line.finish }}</p>
                <p v-if="!line.available" class="mt-1 text-sm text-accent-amber">
                  No longer available. Remove it to check out.
                </p>
                <p v-else class="nums mt-1 text-sm text-text-secondary">{{ format(line.unitPriceCents) }} each</p>
                <p v-if="line.available && line.limited" class="mt-1 text-xs text-accent-amber">
                  Only {{ line.stockCount }} in stock right now, so {{ line.qty }} will be ordered.
                </p>
              </div>

              <div class="flex shrink-0 items-center gap-1 rounded border border-border-hairline">
                <button
                  type="button"
                  class="flex h-8 w-8 items-center justify-center text-text-secondary transition-colors hover:text-text-primary"
                  :aria-label="`Decrease quantity of ${line.title}`"
                  @click="cart.setQty(lineKey(line), line.qty - 1)"
                >
                  <Minus class="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                <span class="nums w-8 text-center text-sm">{{ line.qty }}</span>
                <button
                  type="button"
                  class="flex h-8 w-8 items-center justify-center text-text-secondary transition-colors hover:text-text-primary disabled:opacity-30"
                  :disabled="line.qty >= line.stockCount"
                  :aria-label="`Increase quantity of ${line.title}`"
                  @click="cart.setQty(lineKey(line), line.qty + 1)"
                >
                  <Plus class="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>

              <!-- No total for an unavailable line: its stored price is not a price. -->
              <span class="nums w-24 shrink-0 text-right font-medium">
                <template v-if="line.available">{{ format(line.unitPriceCents * line.qty) }}</template>
              </span>

              <button
                type="button"
                class="shrink-0 text-text-muted transition-colors hover:text-accent-red"
                :aria-label="`Remove ${line.title}`"
                @click="cart.remove(lineKey(line))"
              >
                <X class="h-4 w-4" aria-hidden="true" />
              </button>
            </li>
          </ul>
        </div>

        <aside class="lg:sticky lg:top-24 lg:self-start">
          <div class="rounded-card border border-border-hairline bg-surface-1 p-5">
            <div class="flex items-baseline justify-between">
              <span class="text-text-secondary">Subtotal</span>
              <span class="nums text-xl font-bold">{{ format(cart.subtotalCents) }}</span>
            </div>
            <p class="mt-1 text-xs text-text-muted">
              Shipping and tax depend on the destination, and are calculated at checkout.
            </p>

            <button
              type="button"
              class="btn-primary mt-5 w-full disabled:cursor-not-allowed disabled:opacity-40"
              :disabled="cart.hasUnavailable"
              @click="router.push('/checkout')"
            >
              Checkout
            </button>
            <RouterLink
              to="/shop"
              class="mt-3 block text-center text-sm text-text-secondary transition-colors hover:text-text-primary"
            >
              Continue shopping
            </RouterLink>
          </div>
        </aside>
      </div>
    </div>
  </div>
</template>
