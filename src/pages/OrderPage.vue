<script setup lang="ts">
/**
 * Order confirmation.
 *
 * Reachable by URL, by reload, and from a device that never saw the checkout:
 * the order is read from this browser first and from the API if it is not here,
 * so the link is shareable rather than a bookmark that works on one machine.
 */
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { CheckCircle2, Package } from 'lucide-vue-next'
import { useCheckoutStore, type Order } from '@/stores/checkout'
import { SHIPPING } from '@/lib/money'
import { findCountry } from '@/lib/regions'
import OrderSummary from '@/components/checkout/OrderSummary.vue'
import NotFoundPage from './NotFoundPage.vue'

const props = defineProps<{ id: string }>()

const checkout = useCheckoutStore()
const order = ref<Order | null>(null)
/**
 * Three states, not two. Rendering "no such order" while the lookup is still
 * in flight tells a shopper their purchase vanished, then takes it back.
 */
const status = ref<'loading' | 'found' | 'missing'>('loading')

watch(
  () => props.id,
  async (id) => {
    status.value = 'loading'
    order.value = await checkout.loadOrder(id)
    status.value = order.value ? 'found' : 'missing'
  },
  { immediate: true },
)

/** True only for an order this browser placed and the API confirmed storing. */
const durable = computed(() => checkout.synced[props.id] === true)

const placedOn = computed(() =>
  order.value
    ? new Date(order.value.placedAt).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : '',
)
</script>

<template>
  <div v-if="status === 'loading'" class="pt-16">
    <div class="mx-auto max-w-3xl px-4 py-14 md:px-8">
      <div class="h-8 w-56 animate-pulse rounded bg-surface-2"></div>
      <div class="mt-6 grid gap-3 sm:grid-cols-3">
        <div v-for="n in 3" :key="n" class="h-20 animate-pulse rounded-card bg-surface-2"></div>
      </div>
      <p class="sr-only" role="status">Loading order {{ id }}</p>
    </div>
  </div>

  <NotFoundPage v-else-if="!order" />

  <div v-else class="pt-16">
    <div class="mx-auto max-w-[1600px] px-4 py-10 md:px-8 md:py-14">
      <div class="mx-auto max-w-3xl">
        <div class="mb-8 flex items-start gap-4">
          <CheckCircle2 class="mt-1 h-8 w-8 shrink-0 text-accent-green" aria-hidden="true" />
          <div>
            <h1 class="text-2xl font-bold md:text-3xl">Order confirmed</h1>
            <p class="mt-1 text-text-secondary">
              Thanks, {{ order.address.name.split(' ')[0] }}. A receipt is on its way to
              {{ order.address.email }}.
            </p>
          </div>
        </div>

        <div class="grid gap-3 sm:grid-cols-3">
          <div class="rounded-card border border-border-hairline bg-surface-1 p-4">
            <p class="text-xs text-text-secondary">Order number</p>
            <p class="code mt-1 text-sm font-medium">{{ order.id }}</p>
          </div>
          <div class="rounded-card border border-border-hairline bg-surface-1 p-4">
            <p class="text-xs text-text-secondary">Placed</p>
            <p class="mt-1 text-sm font-medium">{{ placedOn }}</p>
          </div>
          <div class="rounded-card border border-border-hairline bg-surface-1 p-4">
            <p class="text-xs text-text-secondary">Delivery</p>
            <p class="mt-1 text-sm font-medium">{{ SHIPPING[order.method].label }}</p>
          </div>
        </div>

        <div class="mt-6 grid gap-6 md:grid-cols-[1fr_320px]">
          <div class="rounded-card border border-border-hairline bg-surface-1 p-5">
            <h2 class="flex items-center gap-2 text-sm font-semibold">
              <Package class="h-3.5 w-3.5 text-text-secondary" aria-hidden="true" />
              Shipping to
            </h2>
            <!-- The country is spelled out rather than left as a code. A
                 receipt is the one place the destination has to be unambiguous,
                 and "MY" is not. -->
            <address class="mt-3 text-sm not-italic leading-relaxed text-text-secondary">
              {{ order.address.name }}<br />
              {{ order.address.line1 }}<br />
              <template v-if="order.address.line2">{{ order.address.line2 }}<br /></template>
              {{ order.address.city
              }}<template v-if="order.address.state">, {{ order.address.state }}</template>
              {{ order.address.postal }}<br />
              {{ findCountry(order.address.country)?.name ?? order.address.country }}
              <template v-if="order.address.phone">
                <br />{{ order.address.phone }}
              </template>
            </address>
            <p class="mt-4 border-t border-border-hairline pt-4 text-sm text-text-secondary">
              {{ SHIPPING[order.method].label }} · {{ SHIPPING[order.method].transit }}
            </p>
          </div>

          <OrderSummary
            :lines="order.lines"
            :totals="order.totals"
            :method="order.method"
            :country="order.address.country"
            :state="order.address.state"
          />
        </div>

        <p class="mt-6 text-xs text-text-muted">
          This is a demonstration store. No payment was taken and nothing will ship.
          <template v-if="durable">
            This order is stored server-side, so this link opens on any device.
          </template>
          <template v-else>
            This order is kept in this browser, so the page survives a reload.
          </template>
        </p>

        <RouterLink to="/shop" class="btn-primary mt-6 inline-flex">Continue shopping</RouterLink>
      </div>
    </div>
  </div>
</template>
