<script setup lang="ts">
/**
 * Shoppers' reviews of one product: the average, the list newest first, and a
 * form for an account whose order of it was delivered. Who may write is the
 * server's answer (`viewer`), not a guess from the cart or the auth store.
 */
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { Star, ImagePlus, X } from 'lucide-vue-next'
import {
  fetchReviews,
  saveReview,
  deleteReview,
  addReviewPhoto,
  removeReviewPhoto,
  photoNameOf,
  type Review,
  type ReviewPage,
} from '@/lib/uploads'

const props = defineProps<{ productId: string }>()

const MAX_PHOTOS = 3

const data = ref<ReviewPage | null>(null)
const reviews = ref<Review[]>([])
const loadError = ref('')
const busy = ref(false)
const error = ref('')
const rating = ref(0)
const body = ref('')

const own = computed(() => data.value?.viewer?.review ?? null)
const canWrite = computed(() => Boolean(data.value?.viewer?.eligible || own.value))

async function load() {
  const res = await fetchReviews(props.productId)
  if (!res.ok || !Array.isArray(res.data.reviews)) {
    loadError.value = res.ok ? '' : res.error
    return
  }
  loadError.value = ''
  data.value = res.data
  reviews.value = res.data.reviews
  rating.value = res.data.viewer?.review?.rating ?? 0
  body.value = res.data.viewer?.review?.body ?? ''
}

watch(() => props.productId, load, { immediate: true })

async function more() {
  if (data.value?.next == null) return
  const res = await fetchReviews(props.productId, data.value.next)
  if (!res.ok) return
  data.value = { ...res.data, viewer: data.value.viewer }
  reviews.value = [...reviews.value, ...res.data.reviews]
}

/** Every change reloads the page's list and average, so what is shown is what the server stored. */
async function act(run: () => Promise<{ ok: true } | { ok: false; error: string }>) {
  busy.value = true
  error.value = ''
  const res = await run()
  busy.value = false
  if (!res.ok) error.value = res.error
  else await load()
}

const submit = () => {
  if (!rating.value) {
    error.value = 'Choose a rating from 1 to 5 stars.'
    return
  }
  return act(() => saveReview(props.productId, rating.value, body.value))
}
const remove = () => act(() => deleteReview(props.productId))
function addPhoto(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file) return act(() => addReviewPhoto(props.productId, file))
}
const removePhoto = (url: string) => act(() => removeReviewPhoto(props.productId, photoNameOf(url)))

const day = (at: string) =>
  new Date(at.replace(' ', 'T') + 'Z').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
</script>

<template>
  <section class="mt-16 border-t border-border-hairline pt-10" aria-labelledby="reviews-heading">
    <div class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
      <h2 id="reviews-heading" class="text-xl font-bold">Reviews</h2>
      <p v-if="data?.count" class="nums text-sm text-text-secondary">
        <Star class="inline h-4 w-4 fill-accent-amber text-accent-amber" aria-hidden="true" />
        {{ data.average?.toFixed(1) }} out of 5 · {{ data.count }} {{ data.count === 1 ? 'review' : 'reviews' }}
      </p>
    </div>
    <p v-if="loadError" class="mt-4 text-sm text-text-secondary">Reviews could not be loaded. {{ loadError }}</p>

    <!-- Writing one -->
    <div v-if="data" class="mt-6">
      <form
        v-if="canWrite"
        class="rounded-card border border-border-hairline bg-surface-1 p-5"
        @submit.prevent="submit"
      >
        <h3 class="text-sm font-semibold">{{ own ? 'Your review' : 'Write a review' }}</h3>
        <p v-if="own?.hidden" class="mt-1 text-xs text-accent-amber">Hidden by our moderators: only you can see it.</p>
        <fieldset class="mt-3 flex gap-1">
          <legend class="sr-only">Rating</legend>
          <label v-for="n in 5" :key="n" class="cursor-pointer" :title="`${n} star${n === 1 ? '' : 's'}`">
            <input v-model.number="rating" type="radio" name="rating" :value="n" class="sr-only" />
            <Star
              class="h-6 w-6"
              :class="n <= rating ? 'fill-accent-amber text-accent-amber' : 'text-text-muted'"
              aria-hidden="true"
            />
            <span class="sr-only">{{ n }} star{{ n === 1 ? '' : 's' }}</span>
          </label>
        </fieldset>
        <textarea
          v-model="body"
          maxlength="1000"
          rows="3"
          class="input mt-3 w-full"
          placeholder="What stood out? (optional)"
          aria-label="Your review"
        ></textarea>
        <p class="mt-1 text-right text-xs text-text-muted">{{ body.length }}/1000</p>

        <div v-if="own" class="mt-3 flex flex-wrap items-center gap-2">
          <div v-for="p in own.photos" :key="p.large" class="relative">
            <img :src="p.thumb" alt="Your photo" class="h-16 w-16 rounded object-cover" />
            <button
              type="button"
              class="absolute -right-1.5 -top-1.5 rounded-full bg-void p-0.5 text-text-secondary hover:text-text-primary"
              aria-label="Remove photo"
              :disabled="busy"
              @click="removePhoto(p.large)"
            >
              <X class="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
          <label
            v-if="own.photos.length < MAX_PHOTOS"
            class="flex h-16 w-16 cursor-pointer items-center justify-center rounded border border-dashed border-border-strong text-text-secondary hover:text-text-primary"
            title="Add a photo"
          >
            <ImagePlus class="h-5 w-5" aria-hidden="true" />
            <span class="sr-only">Add a photo</span>
            <input type="file" accept="image/*" class="sr-only" :disabled="busy" @change="addPhoto" />
          </label>
        </div>

        <p v-if="error" class="mt-3 text-xs text-accent-red" role="alert">{{ error }}</p>
        <div class="mt-4 flex gap-2">
          <button type="submit" class="btn-primary" :disabled="busy">{{ own ? 'Save changes' : 'Post review' }}</button>
          <button v-if="own" type="button" class="btn-ghost" :disabled="busy" @click="remove">Delete</button>
        </div>
        <p v-if="!own" class="mt-2 text-xs text-text-muted">Save the review first, then add up to {{ MAX_PHOTOS }} photos.</p>
      </form>
      <p v-else-if="data.viewer" class="text-sm text-text-secondary">
        You can review this once your order of it has been delivered.
      </p>
      <p v-else class="text-sm text-text-secondary">
        <RouterLink to="/account" class="text-accent hover:underline">Sign in</RouterLink>
        to review products you bought.
      </p>
    </div>

    <!-- Reading them -->
    <ul v-if="reviews.length" class="mt-8 divide-y divide-border-hairline">
      <li v-for="r in reviews" :key="r.id" class="py-5 first:pt-0">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span class="font-medium">{{ r.author }}</span>
          <span class="flex" :aria-label="`${r.rating} out of 5`">
            <Star
              v-for="n in 5"
              :key="n"
              class="h-3.5 w-3.5"
              :class="n <= r.rating ? 'fill-accent-amber text-accent-amber' : 'text-text-muted'"
              aria-hidden="true"
            />
          </span>
          <span class="text-xs text-text-muted">{{ day(r.createdAt) }}</span>
        </div>
        <p v-if="r.body" class="mt-2 text-sm text-text-secondary">{{ r.body }}</p>
        <div v-if="r.photos.length" class="mt-3 flex gap-2">
          <a v-for="p in r.photos" :key="p.large" :href="p.large" target="_blank" rel="noopener">
            <img :src="p.thumb" :alt="`Photo from ${r.author}`" loading="lazy" class="h-20 w-20 rounded object-cover" />
          </a>
        </div>
      </li>
    </ul>
    <p v-else-if="data" class="mt-6 text-sm text-text-muted">No reviews yet.</p>
    <button v-if="data?.next != null" type="button" class="btn-ghost mt-4" @click="more">More reviews</button>
  </section>
</template>
