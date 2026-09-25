<script setup lang="ts">
// Money owed to the merchant: the balance now, a month's statement with every
// entry and the balance after it, and the payouts made. All of it is summed by
// the worker from the same rule the balance uses; this page formats.
import { computed, onMounted, ref, watch } from 'vue'
import { Download } from 'lucide-vue-next'
import {
  balances,
  ledger,
  payouts,
  isError,
  type Balance,
  type LedgerEntry,
  type LedgerSummary,
  type PayoutRow,
} from '../api'
import { formatBps, formatMinor, minorToDecimal } from '../money'
import { monthRange } from '../dates'
import { placed } from '../orders'
import { download } from '../csv'

const month = ref(new Date().toISOString().slice(0, 7))

const current = ref<Balance[] | null>(null)
const paid = ref<PayoutRow[] | null>(null)
const statement = ref<{ from: string; to: string; commissionBps: number | null; summary: LedgerSummary[]; entries: LedgerEntry[] } | null>(null)
const error = ref<string | null>(null)
const stmtError = ref<string | null>(null)
const stmtLoading = ref(true)

const oops = 'Something went wrong. Reload and try again.'

onMounted(async () => {
  const [b, p] = await Promise.all([balances(), payouts()])
  if (isError(b.body)) error.value = b.body.error
  else if ('balances' in b.body) current.value = b.body.balances
  else error.value = oops
  if (isError(p.body)) error.value = p.body.error
  else if ('payouts' in p.body) paid.value = p.body.payouts
  else error.value = oops
})

async function loadStatement() {
  if (!/^\d{4}-\d{2}$/.test(month.value)) return
  stmtLoading.value = true
  stmtError.value = null
  const { from, to } = monthRange(month.value)
  const { body } = await ledger(from, to)
  if (isError(body)) stmtError.value = body.error
  else if ('entries' in body) statement.value = body
  else stmtError.value = oops
  stmtLoading.value = false
}
watch(month, loadStatement, { immediate: true })

const KIND = { sale: 'Sale', refund: 'Refund', payout: 'Payout' } as const
const monthName = computed(() =>
  new Date(`${month.value}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }),
)

function exportStatement() {
  const s = statement.value!
  download(`statement-${month.value}.csv`, [
    ['Statement', `${s.from} to ${s.to} (UTC)`],
    ['Commission rate', s.commissionBps === null ? '' : formatBps(s.commissionBps)],
    [],
    ['Currency', 'Opening', 'Sales', 'Refunds', 'Commission', 'Payouts', 'Closing'],
    ...s.summary.map((t) => [
      t.currency,
      minorToDecimal(t.opening),
      minorToDecimal(t.sales),
      minorToDecimal(t.refunds),
      minorToDecimal(t.commission),
      minorToDecimal(t.payouts),
      minorToDecimal(t.closing),
    ]),
    [],
    ['Date (UTC)', 'Type', 'Order or reference', 'Currency', 'Amount', 'Commission', 'Balance after'],
    ...s.entries.map((e) => [
      e.at,
      KIND[e.kind],
      e.ref,
      e.currency,
      minorToDecimal(e.amount),
      minorToDecimal(-e.commission),
      minorToDecimal(e.balance),
    ]),
  ])
}
</script>

<template>
  <h1 class="mb-6 font-display text-xl font-bold text-text-primary">Finance</h1>

  <p v-if="error" class="mb-4 text-sm text-accent-amber" role="alert">{{ error }}</p>

  <section class="mb-8" aria-labelledby="balance-h">
    <div class="mb-3 flex flex-wrap items-baseline justify-between gap-2">
      <h2 id="balance-h" class="text-sm font-semibold text-text-primary">Balance</h2>
      <p v-if="statement?.commissionBps != null" class="text-xs text-text-secondary">
        Commission rate: <span class="nums text-text-primary">{{ formatBps(statement.commissionBps) }}</span> of net sales
      </p>
    </div>
    <p v-if="!current && !error" class="text-text-secondary">Loading…</p>
    <p v-else-if="current && current.length === 0" class="card p-6 text-text-secondary">No sales yet, so nothing is owed.</p>
    <div v-else-if="current" class="grid grid-cols-1 gap-3 md:grid-cols-2">
      <div v-for="b in current" :key="b.currency" class="card p-4">
        <div class="mb-3 flex items-baseline justify-between gap-3">
          <span class="label">Available, {{ b.currency }}</span>
          <span class="nums font-display text-xl font-bold text-text-primary">{{ formatMinor(b.available, b.currency) }}</span>
        </div>
        <dl class="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <dt class="text-text-secondary">Gross sales</dt>
          <dd class="nums text-right text-text-primary">{{ formatMinor(b.gross, b.currency) }}</dd>
          <dt class="text-text-secondary">Refunds</dt>
          <dd class="nums text-right text-text-primary">−{{ formatMinor(b.refunds, b.currency) }}</dd>
          <dt class="text-text-secondary">Commission</dt>
          <dd class="nums text-right text-text-primary">−{{ formatMinor(b.commission, b.currency) }}</dd>
          <dt class="text-text-secondary">Paid out</dt>
          <dd class="nums text-right text-text-primary">−{{ formatMinor(b.payouts, b.currency) }}</dd>
        </dl>
      </div>
    </div>
  </section>

  <section class="mb-8" aria-labelledby="statement-h">
    <div class="mb-3 flex flex-wrap items-end justify-between gap-3">
      <h2 id="statement-h" class="text-sm font-semibold text-text-primary">Statement, {{ monthName }}</h2>
      <div class="flex items-end gap-2">
        <div>
          <label class="label mb-1 block" for="stmt-month">Month</label>
          <input id="stmt-month" v-model="month" class="input" type="month" required />
        </div>
        <button
          class="btn-ghost inline-flex items-center gap-2 px-3 py-2"
          :disabled="stmtLoading || !statement"
          @click="exportStatement"
        >
          <Download class="h-4 w-4" aria-hidden="true" />CSV
        </button>
      </div>
    </div>

    <p v-if="stmtError" class="text-sm text-accent-amber" role="alert">{{ stmtError }}</p>
    <p v-else-if="stmtLoading" class="text-text-secondary">Loading…</p>
    <template v-else-if="statement">
      <p v-if="statement.summary.length === 0" class="card p-6 text-text-secondary">Nothing had happened by the end of this month.</p>
      <div v-else class="card mb-4 overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="border-b border-border-hairline">
            <tr class="label">
              <th class="px-4 py-3 font-medium">Currency</th>
              <th class="px-4 py-3 text-right font-medium">Opening</th>
              <th class="px-4 py-3 text-right font-medium">Sales</th>
              <th class="px-4 py-3 text-right font-medium">Refunds</th>
              <th class="px-4 py-3 text-right font-medium">Commission</th>
              <th class="px-4 py-3 text-right font-medium">Payouts</th>
              <th class="px-4 py-3 text-right font-medium">Closing</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in statement.summary" :key="t.currency" class="nums whitespace-nowrap border-b border-border-hairline last:border-0">
              <td class="px-4 py-3 text-text-primary">{{ t.currency }}</td>
              <td class="px-4 py-3 text-right text-text-secondary">{{ formatMinor(t.opening, t.currency) }}</td>
              <td class="px-4 py-3 text-right text-text-primary">{{ formatMinor(t.sales, t.currency) }}</td>
              <td class="px-4 py-3 text-right text-text-primary">−{{ formatMinor(t.refunds, t.currency) }}</td>
              <td class="px-4 py-3 text-right text-text-primary">−{{ formatMinor(t.commission, t.currency) }}</td>
              <td class="px-4 py-3 text-right text-text-primary">−{{ formatMinor(t.payouts, t.currency) }}</td>
              <td class="px-4 py-3 text-right font-semibold text-text-primary">{{ formatMinor(t.closing, t.currency) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="statement.entries.length" class="card overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead class="border-b border-border-hairline">
            <tr class="label">
              <th class="px-4 py-3 font-medium">Date (UTC)</th>
              <th class="px-4 py-3 font-medium">Type</th>
              <th class="px-4 py-3 font-medium">Order or reference</th>
              <th class="px-4 py-3 text-right font-medium">Amount</th>
              <th class="px-4 py-3 text-right font-medium">Commission</th>
              <th class="px-4 py-3 text-right font-medium">Balance</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(e, i) in statement.entries" :key="i" class="nums whitespace-nowrap border-b border-border-hairline last:border-0">
              <td class="px-4 py-3 text-text-secondary">{{ placed(e.at) }}</td>
              <td class="px-4 py-3 text-text-secondary">{{ KIND[e.kind] }}</td>
              <td class="px-4 py-3">
                <router-link v-if="e.kind !== 'payout'" :to="`/orders/${e.ref}`" class="font-mono text-xs text-accent hover:text-accent-hover">{{ e.ref }}</router-link>
                <span v-else class="text-text-primary">{{ e.ref }}</span>
              </td>
              <td class="px-4 py-3 text-right" :class="e.amount < 0 ? 'text-text-secondary' : 'text-text-primary'">{{ formatMinor(e.amount, e.currency) }}</td>
              <td class="px-4 py-3 text-right text-text-secondary">{{ e.commission ? formatMinor(-e.commission, e.currency) : '—' }}</td>
              <td class="px-4 py-3 text-right text-text-primary">{{ formatMinor(e.balance, e.currency) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else-if="statement.summary.length" class="text-sm text-text-secondary">No sales, refunds or payouts this month.</p>
      <p class="mt-3 text-xs text-text-muted">
        Sales are dated when the order was placed; refunds and payouts when they were made. Commission is charged on net sales
        and given back on refunds, so each row's commission is what it moved the total by.
      </p>
    </template>
  </section>

  <section aria-labelledby="payouts-h">
    <h2 id="payouts-h" class="mb-3 text-sm font-semibold text-text-primary">Payouts</h2>
    <p v-if="!paid && !error" class="text-text-secondary">Loading…</p>
    <p v-else-if="paid && paid.length === 0" class="card p-6 text-text-secondary">No payouts yet.</p>
    <div v-else-if="paid" class="card overflow-x-auto">
      <table class="w-full text-left text-sm">
        <thead class="border-b border-border-hairline">
          <tr class="label">
            <th class="px-4 py-3 font-medium">Date (UTC)</th>
            <th class="px-4 py-3 font-medium">Reference</th>
            <th class="px-4 py-3 text-right font-medium">Amount</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in paid" :key="p.id" class="border-b border-border-hairline last:border-0">
            <td class="nums whitespace-nowrap px-4 py-3 text-text-secondary">{{ placed(p.createdAt) }}</td>
            <td class="px-4 py-3 text-text-primary">{{ p.reference }}</td>
            <td class="nums whitespace-nowrap px-4 py-3 text-right text-text-primary">{{ formatMinor(p.amountMinor, p.currency) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
