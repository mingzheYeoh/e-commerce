<script setup lang="ts">
/**
 * Returns on one order: for the account that placed it, each seller's part,
 * whether a return can be asked for on it, and every request with its outcome.
 *
 * Renders nothing for anyone else — the server answers 401 or 404, and a
 * receipt opened from a shared link has no returns to show.
 */
import { ref, watch } from 'vue'
import { RotateCcw, ImagePlus } from 'lucide-vue-next'
import { useCurrency } from '@/composables/useCurrency'
import {
  fetchOrderReturns,
  openReturn,
  addReturnPhoto,
  returnPhotoUrl,
  REASON_LABEL,
  type OrderReturnsView,
  type ReturnReason,
} from '@/lib/uploads'

const props = defineProps<{ orderId: string }>()

const MAX_PHOTOS = 3

const { formatAmount } = useCurrency()
const view = ref<OrderReturnsView | null>(null)
/** The part whose request form is open, by merchant id. */
const asking = ref<string | null>(null)
const reason = ref<ReturnReason>('damaged')
const note = ref('')
const busy = ref(false)
const error = ref('')

async function load() {
  const res = await fetchOrderReturns(props.orderId)
  view.value = res.ok ? res.data : null
}
watch(() => props.orderId, load, { immediate: true })

function ask(merchantId: string) {
  asking.value = merchantId
  reason.value = 'damaged'
  note.value = ''
  error.value = ''
}

async function submit() {
  if (!asking.value) return
  busy.value = true
  error.value = ''
  const res = await openReturn(props.orderId, asking.value, reason.value, note.value)
  busy.value = false
  if (!res.ok) {
    error.value = res.error
    return
  }
  asking.value = null
  await load()
}

async function addPhoto(returnId: string, event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  busy.value = true
  error.value = ''
  const res = await addReturnPhoto(returnId, file)
  busy.value = false
  if (!res.ok) error.value = res.error
  else await load()
}

const STATUS: Record<string, { label: string; badge: string }> = {
  open: { label: 'Waiting for the seller', badge: 'bg-accent/15 text-accent' },
  approved: { label: 'Approved', badge: 'bg-accent-green/15 text-accent-green' },
  rejected: { label: 'Declined', badge: 'bg-accent-red/15 text-accent-red' },
}

const day = (at: string) =>
  new Date(at.replace(' ', 'T') + 'Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
</script>

<template>
  <section
    v-if="view && view.parts.some((p) => p.canRequest || p.requests.length)"
    class="mt-6 rounded-card border border-border-hairline bg-surface-1 p-5"
  >
    <h2 class="flex items-center gap-2 text-sm font-semibold">
      <RotateCcw class="h-3.5 w-3.5 text-text-secondary" aria-hidden="true" />
      Returns
    </h2>
    <ul class="mt-3 divide-y divide-border-hairline">
      <li v-for="p in view.parts" :key="p.merchantId" class="py-3 first:pt-0 last:pb-0">
        <template v-if="p.canRequest || p.requests.length">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="text-sm font-medium">{{ p.seller || 'Seller' }}</span>
            <button
              v-if="p.canRequest && asking !== p.merchantId"
              type="button"
              class="btn-ghost px-3 py-1.5 text-xs"
              @click="ask(p.merchantId)"
            >Request a return</button>
          </div>
          <p v-if="p.canRequest && p.returnBy" class="mt-1 text-xs text-text-muted">
            Returns can be requested until {{ day(p.returnBy) }}.
          </p>

          <form v-if="asking === p.merchantId" class="mt-3 space-y-3" @submit.prevent="submit">
            <label class="block">
              <span class="mb-1.5 block text-xs text-text-secondary">Reason</span>
              <select v-model="reason" class="input">
                <option v-for="r in view.reasons" :key="r" :value="r">{{ REASON_LABEL[r] }}</option>
              </select>
            </label>
            <label class="block">
              <span class="mb-1.5 block text-xs text-text-secondary">What happened? (optional)</span>
              <textarea v-model="note" maxlength="1000" rows="3" class="input w-full"></textarea>
            </label>
            <p class="text-xs text-text-muted">You can add up to {{ MAX_PHOTOS }} photos once the request is sent.</p>
            <div class="flex gap-2">
              <button type="submit" class="btn-primary" :disabled="busy">Send request</button>
              <button type="button" class="btn-ghost" :disabled="busy" @click="asking = null">Cancel</button>
            </div>
          </form>

          <div v-for="r in p.requests" :key="r.id" class="mt-3 rounded border border-border-hairline p-3">
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span>{{ REASON_LABEL[r.reason] ?? r.reason }}</span>
              <span class="rounded-full px-2 py-0.5 text-xs" :class="STATUS[r.status]?.badge">
                {{ STATUS[r.status]?.label ?? r.status }}
              </span>
              <span class="text-xs text-text-muted">asked {{ day(r.createdAt) }}</span>
            </div>
            <p v-if="r.note" class="mt-1 text-sm text-text-secondary">{{ r.note }}</p>
            <p v-if="r.status === 'approved' && r.refundMinor" class="nums mt-1 text-sm text-accent-green">
              Refund of {{ formatAmount({ currency: r.currency, minor: r.refundMinor }) }} approved
            </p>
            <p v-if="r.decisionNote" class="mt-1 text-sm text-text-secondary">Seller: {{ r.decisionNote }}</p>
            <div v-if="r.photos.length || r.status === 'open'" class="mt-2 flex flex-wrap gap-2">
              <img
                v-for="ph in r.photos"
                :key="ph"
                :src="returnPhotoUrl(ph)"
                alt="Your return photo"
                class="h-16 w-16 rounded object-cover"
              />
              <label
                v-if="r.status === 'open' && r.photos.length < MAX_PHOTOS"
                class="flex h-16 w-16 cursor-pointer items-center justify-center rounded border border-dashed border-border-strong text-text-secondary hover:text-text-primary"
                title="Add a photo"
              >
                <ImagePlus class="h-5 w-5" aria-hidden="true" />
                <span class="sr-only">Add a photo</span>
                <input type="file" accept="image/*" class="sr-only" :disabled="busy" @change="addPhoto(r.id, $event)" />
              </label>
            </div>
          </div>
        </template>
      </li>
    </ul>
    <p v-if="error" class="mt-3 text-xs text-accent-red" role="alert">{{ error }}</p>
  </section>
</template>
