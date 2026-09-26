<script setup lang="ts">
/**
 * An order's lines in full: what, which finish, the seller's code for it, the
 * price paid, who sells it and how far that seller's part has got.
 *
 * Shared by the order page and the account page's expanded rows, so the two
 * never disagree about what a line says. A product the catalogue no longer
 * publishes is named in plain text rather than linked to a page that 404s.
 */
import { Package } from 'lucide-vue-next'
import { RouterLink } from 'vue-router'
import { findProduct } from '@/stores/catalog'
import { useCurrency } from '@/composables/useCurrency'
import { lineKey } from '@/stores/cart'
import type { OrderLine } from '@/stores/checkout'
import type { OrderPart } from '@/lib/api'

defineProps<{ lines: OrderLine[] }>()

const { format } = useCurrency()

const PART_LABEL: Record<OrderPart['status'], string> = {
  pending: 'Being prepared',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
}

const PART_BADGE: Record<OrderPart['status'], string> = {
  pending: 'bg-surface-2 text-text-secondary',
  shipped: 'bg-accent/15 text-accent',
  delivered: 'bg-accent-green/15 text-accent-green',
  cancelled: 'bg-accent-red/15 text-accent-red',
}
</script>

<template>
  <ul class="divide-y divide-border-hairline">
    <li v-for="line in lines" :key="lineKey(line)" class="flex gap-3 py-3 first:pt-0 last:pb-0">
      <img
        v-if="line.thumb"
        :src="line.thumb"
        :alt="line.title"
        width="56"
        height="56"
        class="h-14 w-14 shrink-0 rounded object-cover"
      />
      <span v-else class="flex h-14 w-14 shrink-0 items-center justify-center rounded bg-surface-2" aria-hidden="true">
        <Package class="h-5 w-5 text-text-muted" />
      </span>

      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p class="min-w-0 text-sm font-medium">
            <RouterLink v-if="findProduct(line.productId)" :to="`/product/${line.productId}`" class="hover:text-accent">
              {{ line.title }}
            </RouterLink>
            <template v-else>
              {{ line.title }}
              <span class="ml-1 text-xs font-normal text-text-muted">(no longer available)</span>
            </template>
          </p>
          <span class="nums shrink-0 text-sm font-medium">{{ format(line.unitPriceCents * line.qty) }}</span>
        </div>
        <p class="nums mt-0.5 text-xs text-text-secondary">
          <template v-if="line.finish">{{ line.finish }} · </template>SKU <span class="code">{{ line.sku }}</span>
          · {{ format(line.unitPriceCents) }} × {{ line.qty }}
        </p>
        <p v-if="line.seller || line.status" class="mt-1 flex flex-wrap items-center gap-2 text-xs text-text-secondary">
          <span v-if="line.seller">Sold by {{ line.seller }}</span>
          <span v-if="line.status" class="rounded-full px-2 py-0.5" :class="PART_BADGE[line.status]">
            {{ PART_LABEL[line.status] ?? line.status }}
          </span>
        </p>
      </div>
    </li>
  </ul>
</template>
