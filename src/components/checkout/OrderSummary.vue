<script setup lang="ts">
/**
 * The running total, shown on both the checkout wizard and the confirmation.
 *
 * Shipping and tax are labelled with *why* they are what they are — "free over
 * $75", "CA 7.25%" — because a total that appears without explanation is the
 * most common reason a basket is abandoned.
 */
import { computed } from 'vue'
import { taxRate, taxLabel, TAX_POLICY, type ShipMethod } from '@/lib/money'
import { rateFor, isInternational } from '@/lib/shipping'
import { findCountry } from '@/lib/regions'
import { useCurrency } from '@/composables/useCurrency'
import { lineKey, type CartLine } from '@/stores/cart'
import type { OrderTotals } from '@/lib/money'

const props = defineProps<{
  lines: CartLine[]
  totals: OrderTotals
  method: ShipMethod
  country?: string
  state?: string
}>()

const { format } = useCurrency()

const shippingNote = computed(() => {
  const rate = rateFor(props.method, props.country ?? '')
  // A method the destination has no carrier for. The wizard resets the choice,
  // but the summary renders first and should not quote a transit time for a
  // service nobody runs.
  if (!rate) return 'Not available to this address'
  if (props.totals.shipping === 0 && rate.freeAbove !== undefined) {
    return `Free over ${format(rate.freeAbove)}`
  }
  return rate.transit
})

/**
 * Duty paid at checkout rather than on the doorstep.
 *
 * The store collects the destination's VAT or GST up front, which is what
 * "delivered duty paid" means. Worth one line, because the alternative most
 * shoppers have been burned by is a courier asking for money on delivery.
 */
const dutiesPaid = computed(() => isInternational(props.country ?? ''))

/**
 * The tax line names its own authority, not just its rate.
 *
 * "6.00%" tells a shopper nothing they can check. "MY · 8%" and "US-CA · 7.25%"
 * are claims they can hold the receipt against — and the difference between
 * them is the reason the country has to be part of the lookup: `CA` alone is
 * California at 7.25% or Canada at 5%.
 */
const taxTitle = computed(() => taxLabel(props.country ?? ''))

const taxNote = computed(() => {
  const country = (props.country ?? '').trim().toUpperCase()
  const info = findCountry(country)
  if (!info) return 'Added once we have your address'

  const sub = (props.state ?? '').trim().toUpperCase()
  /*
   * Whether the answer has to wait is a question about the TAX, not about the
   * geography. Malaysia has states and a single national rate; keying this off
   * `info.subdivisions` printed "Added once we have your state" directly above
   * a tax line that already read $191.84.
   */
  if (TAX_POLICY[country]?.bySubdivision && !sub) {
    return `Added once we have your ${info.subdivisionLabel?.toLowerCase() ?? 'region'}`
  }

  const rate = taxRate(country, sub)
  const where = sub ? `${country}-${sub}` : country
  if (rate === 0) return `${where} · none due`
  const pct = (rate * 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
  return `${where} · ${pct}%`
})
</script>

<template>
  <aside class="rounded-card border border-border-hairline bg-surface-1 p-5">
    <h2 class="text-sm font-semibold">Order summary</h2>

    <ul class="mt-4 space-y-3 border-b border-border-hairline pb-4">
      <li v-for="line in lines" :key="lineKey(line)" class="flex items-center gap-3">
        <img :src="line.thumb" :alt="line.title" width="40" height="40" class="h-10 w-10 shrink-0 rounded object-cover" />
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm">{{ line.title }}</span>
          <span class="nums block text-xs text-text-secondary">
            Qty {{ line.qty }}<template v-if="line.finish"> · {{ line.finish }}</template>
          </span>
        </span>
        <span class="nums shrink-0 text-sm">{{ format(line.unitPriceCents * line.qty) }}</span>
      </li>
    </ul>

    <dl class="mt-4 space-y-2.5 text-sm">
      <div class="flex justify-between">
        <dt class="text-text-secondary">Subtotal</dt>
        <dd class="nums">{{ format(totals.subtotal) }}</dd>
      </div>
      <div class="flex justify-between">
        <dt class="text-text-secondary">
          Shipping
          <span class="block text-xs text-text-muted">{{ shippingNote }}</span>
        </dt>
        <dd class="nums" :class="totals.shipping === 0 && 'text-accent-green'">
          {{ totals.shipping === 0 ? 'Free' : format(totals.shipping) }}
        </dd>
      </div>
      <div class="flex justify-between">
        <dt class="text-text-secondary">
          {{ taxTitle }}
          <span class="block text-xs text-text-muted">{{ taxNote }}</span>
        </dt>
        <dd class="nums">{{ format(totals.tax) }}</dd>
      </div>
    </dl>

    <div class="mt-4 flex items-baseline justify-between border-t border-border-hairline pt-4">
      <span class="font-semibold">Total</span>
      <span class="nums text-xl font-bold">{{ format(totals.total) }}</span>
    </div>

    <!-- Not lower-cased: every label here but one is an acronym, and "Duties
         and sst are paid at checkout" is what lower-casing them produces. -->
    <p v-if="dutiesPaid" class="mt-3 text-xs text-text-muted">
      Duties and {{ taxTitle }} are paid at checkout. Nothing further is owed to the carrier on
      delivery.
    </p>
  </aside>
</template>
