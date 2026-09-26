<script setup lang="ts">
// Shoppers' reviews. A merchant reads the reviews of its own products and
// cannot change them; the platform reads every one and can hide or unhide it
// (audited). Hidden reviews stay listed here, marked, so they can be restored.
import { onMounted, ref } from 'vue'
import { listReviews, setReviewHidden, isError, type Scope, type StaffReview } from '../api'
import { placed } from '../orders'

const props = defineProps<{ scope: Scope }>()

const reviews = ref<StaffReview[]>([])
const error = ref<string | null>(null)
const actionError = ref<string | null>(null)
const loading = ref(true)
const busy = ref<string | null>(null)

async function load() {
  const { body } = await listReviews(props.scope)
  if (isError(body)) error.value = body.error
  else if ('reviews' in body) reviews.value = body.reviews
  else error.value = 'Something went wrong. Reload and try again.'
  loading.value = false
}
onMounted(load)

async function toggle(r: StaffReview) {
  busy.value = r.id
  actionError.value = null
  const { body } = await setReviewHidden(r.id, !r.hidden)
  busy.value = null
  if (isError(body)) actionError.value = body.error
  else if ('hidden' in body) r.hidden = body.hidden
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <header>
      <h1 class="font-display text-xl font-bold text-text-primary">Reviews</h1>
      <p class="mt-1 text-sm text-text-secondary">
        <template v-if="scope === 'platform'">Every product's reviews. Hiding one takes it off the product page and out of its average.</template>
        <template v-else>What shoppers who received your products said. Reviews cannot be edited by sellers.</template>
      </p>
    </header>

    <p v-if="actionError" class="text-sm text-accent-amber" role="alert">{{ actionError }}</p>
    <p v-if="error" class="text-sm text-accent-amber">{{ error }}</p>
    <p v-else-if="loading" class="text-text-secondary">Loading…</p>
    <p v-else-if="!reviews.length" class="text-sm text-text-secondary">No reviews yet.</p>
    <ul v-else class="flex flex-col gap-3">
      <li v-for="r in reviews" :key="r.id" class="card p-4" :class="r.hidden ? 'opacity-60' : ''">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span class="font-medium text-text-primary">{{ r.productTitle || r.productId }}</span>
          <span class="nums text-accent-amber" :aria-label="`${r.rating} out of 5`">{{ '★'.repeat(r.rating) }}{{ '☆'.repeat(5 - r.rating) }}</span>
          <span class="text-text-secondary">{{ r.author }}</span>
          <span class="nums text-xs text-text-muted">{{ placed(r.createdAt) }}</span>
          <span v-if="r.hidden" class="rounded-full border border-border-strong px-2 py-0.5 text-xs text-text-secondary">Hidden</span>
          <span v-if="scope === 'platform'" class="font-mono text-xs text-text-muted">{{ r.merchantId }}</span>
          <button
            v-if="scope === 'platform'"
            type="button"
            class="btn-ghost ml-auto px-3 py-1 text-xs"
            :disabled="busy === r.id"
            @click="toggle(r)"
          >{{ r.hidden ? 'Unhide' : 'Hide' }}</button>
        </div>
        <p v-if="r.body" class="mt-2 text-sm text-text-secondary">{{ r.body }}</p>
        <div v-if="r.photos.length" class="mt-3 flex gap-2">
          <a v-for="p in r.photos" :key="p.large" :href="p.large" target="_blank" rel="noopener">
            <img :src="p.thumb" alt="Photo from the shopper" loading="lazy" class="h-16 w-16 rounded object-cover" />
          </a>
        </div>
      </li>
    </ul>
  </div>
</template>
