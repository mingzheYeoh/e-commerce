<script setup lang="ts">
// One return request: what the shopper said, their photos, the part's lines
// and what is left to refund. A merchant approves (a refund, through the same
// path and cap as a refund from the order page) or rejects with a note the
// shopper reads. The platform sees the same page without the buttons.
import { computed, onMounted, ref } from 'vue'
import { getReturn, approveReturn, rejectReturn, isError, type ErrorBody, type ReturnDetail, type Scope } from '../api'
import { formatMinor, parsePriceToMinor, minorToDecimal } from '../money'
import { REASON, RETURN_STATUS, placed } from '../orders'

const props = defineProps<{ id: string; scope: Scope }>()

const request = ref<ReturnDetail | null>(null)
const error = ref<string | null>(null)
const actionError = ref<string | null>(null)
const busy = ref(false)
const amount = ref('')
const note = ref('')

const back = computed(() => (props.scope === 'platform' ? '/platform/returns' : '/returns'))
const deciding = computed(() => props.scope === 'merchant' && request.value?.status === 'open')

async function load() {
  const { status, body } = await getReturn(props.scope, props.id)
  if (status === 404) error.value = 'No return request with that id.'
  else if (isError(body)) error.value = body.error
  else if ('lines' in body) {
    request.value = body
    // The whole remainder, as the usual answer to a damaged item.
    amount.value = minorToDecimal(body.refundable)
  } else error.value = 'Something went wrong. Reload and try again.'
}
onMounted(load)

async function act(run: () => Promise<{ body: object | ErrorBody }>) {
  busy.value = true
  actionError.value = null
  try {
    const { body } = await run()
    if (isError(body)) actionError.value = body.error
    else await load()
  } finally {
    busy.value = false
  }
}

function approve() {
  const r = request.value
  if (!r) return
  const minor = parsePriceToMinor(amount.value)
  if (!minor) {
    actionError.value = 'The amount is a price such as 12.50, more than zero.'
    return
  }
  if (minor > r.refundable) {
    actionError.value = `At most ${formatMinor(r.refundable, r.currency)} is left to refund on this order.`
    return
  }
  if (!window.confirm(`Refund ${formatMinor(minor, r.currency)} and approve this return?\n\nThis cannot be undone.`)) return
  void act(() => approveReturn(r.id, minor, note.value.trim()))
}

function reject() {
  if (!note.value.trim()) {
    actionError.value = 'A rejection needs a note: the shopper will read it.'
    return
  }
  void act(() => rejectReturn(props.id, note.value.trim()))
}
</script>

<template>
  <router-link :to="back" class="mb-4 inline-block text-sm text-text-secondary hover:text-text-primary">← Returns</router-link>

  <p v-if="error" class="text-sm text-accent-amber">{{ error }}</p>
  <p v-else-if="!request" class="text-text-secondary">Loading…</p>
  <div v-else class="flex flex-col gap-6">
    <header class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
      <h1 class="font-display text-lg font-bold text-text-primary">Return on <span class="font-mono">{{ request.orderId }}</span></h1>
      <span class="rounded-full border px-2 py-0.5 text-xs" :class="RETURN_STATUS[request.status]?.badge">
        {{ RETURN_STATUS[request.status]?.label ?? request.status }}
      </span>
    </header>

    <p v-if="actionError" class="text-sm text-accent-amber" role="alert">{{ actionError }}</p>

    <div class="grid grid-cols-1 gap-6 md:grid-cols-3">
      <section class="card p-4 md:col-span-1">
        <h2 class="label mb-2">The request</h2>
        <dl class="flex flex-col gap-1 text-sm">
          <dt class="text-text-secondary">Reason</dt>
          <dd class="text-text-primary">{{ REASON[request.reason] ?? request.reason }}</dd>
          <template v-if="request.note">
            <dt class="text-text-secondary">Shopper's note</dt>
            <dd class="whitespace-pre-line text-text-primary">{{ request.note }}</dd>
          </template>
          <dt class="text-text-secondary">Asked</dt>
          <dd class="nums text-text-primary">{{ placed(request.createdAt) }} UTC</dd>
          <template v-if="request.deliveredAt">
            <dt class="text-text-secondary">Delivered</dt>
            <dd class="nums text-text-primary">{{ placed(request.deliveredAt) }} UTC</dd>
          </template>
          <template v-if="scope === 'platform'">
            <dt class="text-text-secondary">Merchant</dt>
            <dd class="font-mono text-xs text-text-primary">{{ request.merchantId }}</dd>
          </template>
          <template v-if="request.refundMinor">
            <dt class="text-text-secondary">Refunded</dt>
            <dd class="nums text-accent-green">{{ formatMinor(request.refundMinor, request.currency) }}</dd>
          </template>
          <template v-if="request.decisionNote">
            <dt class="text-text-secondary">Note to the shopper</dt>
            <dd class="text-text-primary">{{ request.decisionNote }}</dd>
          </template>
        </dl>
        <div v-if="request.photos.length" class="mt-4 flex flex-wrap gap-2">
          <a v-for="p in request.photos" :key="p" :href="p" target="_blank" rel="noopener">
            <img :src="p" alt="Photo from the shopper" class="h-24 w-24 rounded object-cover" />
          </a>
        </div>
      </section>

      <div class="flex flex-col gap-6 md:col-span-2">
        <section class="card">
          <table class="w-full text-left text-sm">
            <thead class="border-b border-border-hairline">
              <tr class="label">
                <th class="px-4 py-3 font-medium">Items on this order</th>
                <th class="px-4 py-3 text-right font-medium">Paid</th>
                <th class="px-4 py-3 text-right font-medium">Refunded</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="l in request.lines" :key="`${l.productId}|${l.finish ?? ''}`" class="border-b border-border-hairline">
                <td class="px-4 py-3">
                  <p class="text-text-primary">{{ l.qty }} × {{ l.title }}</p>
                  <p class="code">{{ l.sku }}<template v-if="l.finish"> · {{ l.finish }}</template></p>
                </td>
                <td class="nums px-4 py-3 text-right text-text-secondary">{{ formatMinor(l.paid, request.currency) }}</td>
                <td class="nums px-4 py-3 text-right text-text-secondary">{{ formatMinor(l.refundedMinor, request.currency) }}</td>
              </tr>
            </tbody>
          </table>
          <p class="nums px-4 py-3 text-right text-sm">
            <span class="text-text-secondary">Left to refund</span>
            <span class="ml-3 font-semibold text-text-primary">{{ formatMinor(request.refundable, request.currency) }}</span>
          </p>
        </section>

        <section v-if="deciding" class="card flex flex-col gap-3 p-4">
          <h2 class="label">Decide</h2>
          <div class="flex flex-wrap gap-3">
            <div class="w-36">
              <label class="label mb-1 block" for="return-amount">Refund ({{ request.currency }})</label>
              <input id="return-amount" v-model="amount" class="input" inputmode="decimal" />
            </div>
            <div class="min-w-[14rem] flex-1">
              <label class="label mb-1 block" for="return-note">Note to the shopper</label>
              <input id="return-note" v-model="note" class="input" maxlength="1000" placeholder="Required to reject" />
            </div>
          </div>
          <div class="flex flex-wrap gap-2">
            <button class="btn-primary" type="button" :disabled="busy" @click="approve">Approve and refund</button>
            <button class="btn-ghost" type="button" :disabled="busy" @click="reject">Reject</button>
          </div>
          <p class="text-xs text-text-secondary">
            Approving refunds the amount across these items, up to what is left; it does not restock them.
          </p>
        </section>
      </div>
    </div>
  </div>
</template>
