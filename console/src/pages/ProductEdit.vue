<script setup lang="ts">
// There is no single-product GET, so this loads the merchant's whole list and
// picks the one whose id matches the route — the contract the worker gives
// us, not a route added to it.
import { computed, onMounted, ref } from 'vue'
import {
  listProducts,
  updateProduct,
  uploadPhoto,
  makeMainPhoto,
  deletePhoto,
  isError,
  asProduct,
  type Product,
  type ProductStatus,
  type SpecRow,
} from '../api'
import { parsePriceToMinor } from '../money'
import { CATEGORIES } from '../categories'
import { toWebp, photoName, thumbOf } from '../photos'

const props = defineProps<{ id: string }>()

const product = ref<Product | null>(null)
const notFound = ref(false)
const loading = ref(true)

const title = ref('')
const price = ref('')
const stock = ref('')
const status = ref<ProductStatus>('draft')
const category = ref('')
const highlights = ref(['', '', ''])
const specs = ref<SpecRow[]>([])

const error = ref<string | null>(null)
const saved = ref(false)
const saving = ref(false)

const MAX_PHOTOS = 6
const gallery = computed(() => product.value?.media.gallery ?? [])
/** One line per photo being resized or uploaded, so a failure names its file. */
const uploads = ref<{ key: number; file: string; state: string; failed: boolean }[]>([])
let nextKey = 0
const photoError = ref<string | null>(null)
const acting = ref(false)
// A reorder or delete while an upload is landing would make that upload lose
// its conflict check, so every photo control waits for the others.
const busy = computed(() => acting.value || uploads.value.some((u) => !u.failed && u.state !== 'Done'))

function load(p: Product) {
  product.value = p
  title.value = p.title
  price.value = (p.priceMinor / 100).toFixed(2)
  stock.value = String(p.stockCount)
  status.value = p.status
  category.value = p.category
  highlights.value = [0, 1, 2].map((i) => p.specsSummary[i] ?? '')
  specs.value = p.specs.map((r) => ({ ...r }))
}

onMounted(async () => {
  const { body } = await listProducts()
  const found = isError(body) ? undefined : body.products.find((p) => p.id === props.id)
  if (found) load(found)
  else notFound.value = true
  loading.value = false
})

async function submit() {
  error.value = null
  saved.value = false
  const priceMinor = parsePriceToMinor(price.value)
  if (priceMinor === null) {
    error.value = 'Enter a price like 19.99.'
    return
  }
  const stockCount = Number(stock.value)
  if (!Number.isInteger(stockCount) || stockCount < 0) {
    error.value = 'Stock is a whole number, zero or more.'
    return
  }
  saving.value = true
  try {
    const { body: raw } = await updateProduct(props.id, {
      title: title.value,
      priceMinor,
      stockCount,
      status: status.value,
      category: category.value,
      specsSummary: highlights.value,
      specs: specs.value,
    })
    const body = asProduct(raw)
    if (isError(body)) {
      error.value = body.error
    } else {
      load(body)
      saved.value = true
    }
  } finally {
    saving.value = false
  }
}

/* Photos act immediately, not on Save: each one is its own request. */

async function addPhotos(event: Event) {
  const input = event.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  input.value = '' // so choosing the same file again still fires change
  photoError.value = null
  const room = MAX_PHOTOS - gallery.value.length
  if (files.length > room) photoError.value = `Only ${room} more photo${room === 1 ? '' : 's'} fit; the rest were skipped.`

  // One at a time: the worker refuses a change made while another is landing.
  for (const file of files.slice(0, room)) {
    uploads.value.push({ key: nextKey++, file: file.name, state: 'Resizing…', failed: false })
    // The reactive proxy, not the literal just pushed: mutating the literal
    // would change the data without re-rendering the line.
    const line = uploads.value[uploads.value.length - 1]!
    try {
      const [large, thumb] = await Promise.all([toWebp(file, 1600), toWebp(file, 400)])
      line.state = 'Uploading…'
      const body = asProduct((await uploadPhoto(props.id, large, thumb)).body)
      if (isError(body)) throw new Error(body.error)
      product.value = body
      line.state = 'Done'
    } catch (err) {
      line.state = err instanceof Error ? err.message : 'Upload failed.'
      line.failed = true
    }
  }
  uploads.value = uploads.value.filter((u) => u.failed)
}

async function photoAction(url: string, action: 'main' | 'delete') {
  if (busy.value) return
  photoError.value = null
  acting.value = true
  try {
    const name = photoName(url)
    const res = action === 'main' ? await makeMainPhoto(props.id, name) : await deletePhoto(props.id, name)
    const body = asProduct(res.body)
    if (isError(body)) photoError.value = body.error
    else product.value = body
  } finally {
    acting.value = false
  }
}
</script>

<template>
  <div class="max-w-2xl">
    <h1 class="mb-6 font-display text-xl font-bold text-text-primary">Edit product</h1>

    <p v-if="loading" class="text-text-secondary">Loading…</p>
    <p v-else-if="notFound" class="card p-6 text-text-secondary">
      No product with that id.
      <router-link to="/products" class="text-accent">Back to products</router-link>
    </p>
    <template v-else>
      <section class="card mb-6 flex flex-col gap-4 p-6">
        <div>
          <h2 class="font-semibold text-text-primary">Photos</h2>
          <p class="text-sm text-text-secondary">
            Up to {{ MAX_PHOTOS }}. The first is the main photo; the second shows when a shopper hovers the card.
          </p>
        </div>

        <ul v-if="gallery.length" class="grid grid-cols-3 gap-3">
          <li v-for="(url, i) in gallery" :key="url" class="flex flex-col gap-2">
            <img :src="thumbOf(url)" :alt="`Photo ${i + 1}`" class="aspect-square w-full rounded bg-white object-contain" />
            <span v-if="i === 0" class="text-xs font-semibold text-accent">Main photo</span>
            <button v-else class="text-left text-xs text-text-secondary underline disabled:opacity-50" type="button" :disabled="busy" @click="photoAction(url, 'main')">
              Make main
            </button>
            <button class="text-left text-xs text-accent-amber underline disabled:opacity-50" type="button" :disabled="busy" @click="photoAction(url, 'delete')">
              Delete
            </button>
          </li>
        </ul>
        <p v-else class="text-sm text-text-secondary">No photos yet. A product needs at least one to be published.</p>

        <ul v-if="uploads.length" class="flex flex-col gap-1 text-sm">
          <li v-for="u in uploads" :key="u.key" :class="u.failed ? 'text-accent-amber' : 'text-text-secondary'">
            {{ u.file }}: {{ u.state }}
          </li>
        </ul>
        <p v-if="photoError" class="text-sm text-accent-amber">{{ photoError }}</p>

        <label v-if="gallery.length < MAX_PHOTOS" class="btn-ghost w-fit cursor-pointer" :class="{ 'opacity-50': busy }">
          {{ busy ? 'Uploading…' : 'Add photos' }}
          <input class="sr-only" type="file" accept="image/*" multiple :disabled="busy" @change="addPhotos" />
        </label>
      </section>

      <form class="card flex flex-col gap-4 p-6" @submit.prevent="submit">
        <p class="text-sm text-text-secondary">
          <span class="code">{{ product?.sku }}</span> · {{ product?.brand }}
        </p>
        <div>
          <label class="label mb-1 block" for="edit-title">Title</label>
          <input id="edit-title" v-model="title" class="input" type="text" required maxlength="200" />
        </div>
        <div>
          <label class="label mb-1 block" for="edit-category">Category</label>
          <select id="edit-category" v-model="category" class="input">
            <option v-for="c in CATEGORIES" :key="c.id" :value="c.id">{{ c.label }}</option>
          </select>
        </div>
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="label mb-1 block" for="edit-price">Price</label>
            <input id="edit-price" v-model="price" class="input" type="text" inputmode="decimal" required />
          </div>
          <div>
            <label class="label mb-1 block" for="edit-stock">Stock</label>
            <input id="edit-stock" v-model="stock" class="input" type="number" min="0" step="1" required />
          </div>
        </div>

        <fieldset class="flex flex-col gap-2">
          <legend class="label mb-1">Highlights</legend>
          <p class="text-xs text-text-secondary">Three short lines shown on the product card, e.g. "40-hour battery".</p>
          <input
            v-for="(_, i) in highlights"
            :key="i"
            v-model="highlights[i]"
            class="input"
            type="text"
            maxlength="60"
            :aria-label="`Highlight ${i + 1}`"
          />
        </fieldset>

        <fieldset class="flex flex-col gap-2">
          <legend class="label mb-1">Specifications</legend>
          <p class="text-xs text-text-secondary">The table on the product page, e.g. Weight · 250 g.</p>
          <div v-for="(row, i) in specs" :key="i" class="flex gap-2">
            <input v-model="row.label" class="input w-2/5" type="text" maxlength="40" placeholder="Name" :aria-label="`Specification ${i + 1} name`" />
            <input v-model="row.value" class="input flex-1" type="text" maxlength="120" placeholder="Value" :aria-label="`Specification ${i + 1} value`" />
            <button class="btn-ghost" type="button" :aria-label="`Remove specification ${i + 1}`" @click="specs.splice(i, 1)">✕</button>
          </div>
          <button
            v-if="specs.length < 20"
            class="btn-ghost w-fit"
            type="button"
            @click="specs.push({ label: '', value: '' })"
          >
            + Add a row
          </button>
        </fieldset>

        <div>
          <label class="label mb-1 block" for="edit-status">Status</label>
          <select id="edit-status" v-model="status" class="input">
            <option value="draft">Draft</option>
            <option value="published">Published</option>
            <option value="archived">Archived</option>
          </select>
        </div>
        <p v-if="error" class="text-sm text-accent-amber">{{ error }}</p>
        <p v-if="saved" class="text-sm text-accent">Saved.</p>
        <div class="flex gap-3">
          <button class="btn-primary" type="submit" :disabled="saving">
            {{ saving ? 'Saving…' : 'Save' }}
          </button>
          <router-link to="/products" class="btn-ghost">Back</router-link>
        </div>
      </form>
    </template>
  </div>
</template>
