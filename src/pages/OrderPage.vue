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
import { CheckCircle2, Package, Truck } from 'lucide-vue-next'
import { useCheckoutStore, type Order } from '@/stores/checkout'
import { useCurrency } from '@/composables/useCurrency'
import { SHIP_METHODS } from '@/lib/money'
import { rateFor } from '@/lib/shipping'
import { findCountry } from '@/lib/regions'
import type { OrderPart } from '@/lib/api'
import OrderSummary from '@/components/checkout/OrderSummary.vue'
import NotFoundPage from './NotFoundPage.vue'

const props = defineProps<{ id: string }>()

const checkout = useCheckoutStore()
const { formatAmount } = useCurrency()
const order = ref<Order | null>(null)
/**
 * Each seller's delivery and refunds. Null unless the signed-in account placed
 * this order: the server leaves them out for anyone else holding the link.
 */
const parts = ref<OrderPart[] | null>(null)
/**
 * Three states, not two. Rendering "no such order" while the lookup is still
 * in flight tells a shopper their purchase vanished, then takes it back.
 */
const status = ref<'loading' | 'found' | 'missing'>('loading')

watch(
  () => props.id,
  async (id) => {
    status.value = 'loading'
    parts.value = null
    ;[order.value, parts.value] = await Promise.all([checkout.loadOrder(id), checkout.loadParts(id)])
    status.value = order.value ? 'found' : 'missing'
  },
  { immediate: true },
)

const PART_LABEL: Record<OrderPart['status'], string> = {
  pending: 'Being prepared',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'Cancelled and refunded',
}

const PART_BADGE: Record<OrderPart['status'], string> = {
  pending: 'bg-surface-2 text-text-secondary',
  shipped: 'bg-accent/15 text-accent',
  delivered: 'bg-accent-green/15 text-accent-green',
  cancelled: 'bg-accent-red/15 text-accent-red',
}

/** SQLite's UTC timestamp as a date in the shopper's own words. */
const day = (at: string) =>
  new Date(at.replace(' ', 'T') + 'Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric' })

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
            <p class="mt-1 text-sm font-medium">{{ SHIP_METHODS[order.method].label }}</p>
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
              <!-- Blank when this browser is not the account that placed it:
                   the API keeps the street to the owner. -->
              <template v-if="order.address.line1">{{ order.address.line1 }}<br /></template>
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
              {{ SHIP_METHODS[order.method].label }}
              <template v-if="rateFor(order.method, order.address.country)">
                · {{ rateFor(order.method, order.address.country)!.transit }}
              </template>
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

        <!-- Each seller ships its own items, so each has its own status. -->
        <section v-if="parts?.length" class="mt-6 rounded-card border border-border-hairline bg-surface-1 p-5">
          <h2 class="flex items-center gap-2 text-sm font-semibold">
            <Truck class="h-3.5 w-3.5 text-text-secondary" aria-hidden="true" />
            Shipments
          </h2>
          <ul class="mt-3 divide-y divide-border-hairline">
            <li v-for="(p, i) in parts" :key="i" class="py-3 first:pt-0 last:pb-0">
              <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span class="text-sm font-medium">{{ p.seller || 'Seller' }}</span>
                <span class="rounded-full px-2 py-0.5 text-xs" :class="PART_BADGE[p.status]">
                  {{ PART_LABEL[p.status] ?? p.status }}
                </span>
              </div>
              <p class="mt-1 text-sm text-text-secondary">
                {{ p.items.map((it) => `${it.qty} × ${it.title}${it.finish ? ` (${it.finish})` : ''}`).join(', ') }}
              </p>
              <p v-if="p.carrier" class="mt-1 text-sm text-text-secondary">
                {{ p.carrier }} · tracking <span class="code">{{ p.tracking }}</span>
                <template v-if="p.shippedAt"> · shipped {{ day(p.shippedAt) }}</template>
                <template v-if="p.deliveredAt"> · delivered {{ day(p.deliveredAt) }}</template>
              </p>
              <p v-if="p.refunded.length" class="nums mt-1 text-sm text-accent-amber">
                Refunded {{ p.refunded.map(formatAmount).join(' · ') }}
              </p>
            </li>
          </ul>
        </section>

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
