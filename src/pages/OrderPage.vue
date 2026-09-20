<script setup lang="ts">
/**
 * Order confirmation.
 *
 * Reachable by URL and by reload, which is why the order is read from storage
 * rather than from whatever the checkout store happened to hold — this page
 * outlives the session that placed the order.
 */
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { CheckCircle2, Package } from 'lucide-vue-next'
import { useCheckoutStore } from '@/stores/checkout'
import { SHIPPING } from '@/lib/money'
import OrderSummary from '@/components/checkout/OrderSummary.vue'
import NotFoundPage from './NotFoundPage.vue'

const props = defineProps<{ id: string }>()

const checkout = useCheckoutStore()
const order = computed(() => checkout.findOrder(props.id))

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
  <NotFoundPage v-if="!order" />

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
            <address class="mt-3 text-sm not-italic leading-relaxed text-text-secondary">
              {{ order.address.name }}<br />
              {{ order.address.line1 }}<br />
              {{ order.address.city }}, {{ order.address.state }} {{ order.address.postal }}
            </address>
            <p class="mt-4 border-t border-border-hairline pt-4 text-sm text-text-secondary">
              {{ SHIPPING[order.method].label }} · {{ SHIPPING[order.method].transit }}
            </p>
          </div>

          <OrderSummary
            :lines="order.lines"
            :totals="order.totals"
            :method="order.method"
            :state="order.address.state"
          />
        </div>

        <p class="mt-6 text-xs text-text-muted">
          This is a demonstration store. No payment was taken and nothing will ship. The order is
          kept in this browser so the page survives a reload.
        </p>

        <RouterLink to="/shop" class="btn-primary mt-6 inline-flex">Continue shopping</RouterLink>
      </div>
    </div>
  </div>
</template>
