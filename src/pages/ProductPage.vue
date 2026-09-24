<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import BuyBox from '@/components/commerce/BuyBox.vue'
import ProductCard from '@/components/commerce/ProductCard.vue'
import DeconstructedFlagship from '@/components/sections/DeconstructedFlagship.vue'
import NotFoundPage from './NotFoundPage.vue'
import { catalogue, catalogueStatus, findProduct } from '@/stores/catalog'
import { categories } from '@/data/categories'
import { flagship } from '@/data/flagship'
import credits from '@/data/credits.json'
import type { Credit } from '@/types'

const props = defineProps<{ id: string }>()

const product = computed(() => findProduct(props.id))

/**
 * An id the snapshot does not know may be a product published since the build.
 * Until the live catalogue has answered that is "loading", and if the fetch
 * failed it is "could not check" - only a live answer can say "not found".
 */
const waiting = computed(() => !product.value && catalogueStatus.value === 'pending')
const unreachable = computed(() => !product.value && catalogueStatus.value === 'failed')

/**
 * Commons rarely has four photographs of one model, so the pipeline writes as
 * many as it found. Rather than guess, each candidate path is probed once and
 * only the ones that resolve are shown — a 404 in a gallery is worse than a
 * shorter gallery.
 */
const gallery = ref<string[]>([])

watch(
  // The paths, not the id: the live catalogue can hand back the same product
  // with different photos, and the same photos must not re-probe.
  () => product.value?.media.gallery.join(' '),
  async (_paths, _old, onCleanup) => {
    // A slower probe for the previous product must not overwrite this one's.
    let stale = false
    onCleanup(() => (stale = true))
    gallery.value = []
    if (!product.value) return
    const candidates = product.value.media.gallery
    const checks = await Promise.all(
      candidates.map(
        (src) =>
          new Promise<string | null>((resolve) => {
            const probe = new Image()
            probe.onload = () => resolve(src)
            probe.onerror = () => resolve(null)
            probe.src = src
          }),
      ),
    )
    if (!stale) gallery.value = checks.filter((src): src is string => src !== null)
  },
  { immediate: true },
)

const active = ref(0)
watch(() => props.id, () => (active.value = 0))

/**
 * Attribution for the image on screen. Commons photographs are CC BY-SA, which
 * requires the author and licence to be named wherever the work appears — a
 * line in the footer is not enough on its own.
 */
const creditFor = computed<Credit | undefined>(() => {
  const src = gallery.value[active.value]
  if (!src) return undefined
  const file = src.replace(/^\//, '')
  return (credits as Credit[]).find((c) => c.file === file)
})

const categoryLabel = computed(
  () => categories.find((c) => c.id === product.value?.category)?.label ?? 'Shop',
)

/** Only one product has teardown geometry; everything else gets a normal page. */
const hasTeardown = computed(() => product.value?.sku === flagship.sku)

const related = computed(() =>
  catalogue.value
    .filter((p) => p.category === product.value?.category && p.id !== product.value?.id)
    .slice(0, 4),
)
</script>

<template>
  <div v-if="waiting" class="flex min-h-[70vh] items-center justify-center pt-16" role="status">
    <p class="text-text-secondary">Loading product…</p>
  </div>

  <div v-else-if="unreachable" class="flex min-h-[70vh] flex-col items-center justify-center gap-4 px-4 pt-16 text-center" role="status">
    <p class="text-text-secondary">We couldn't load this product right now. Check your connection and try again.</p>
    <RouterLink to="/shop" class="btn-secondary">Browse all products</RouterLink>
  </div>

  <NotFoundPage v-else-if="!product" />

  <div v-else class="pt-16">
    <div class="mx-auto max-w-[1600px] px-4 py-8 md:px-8 md:py-12">
      <nav class="mb-8 text-sm text-text-secondary" aria-label="Breadcrumb">
        <RouterLink to="/" class="transition-colors hover:text-text-primary">Home</RouterLink>
        <span class="mx-2 text-text-muted">/</span>
        <RouterLink
          :to="{ path: '/shop', query: { category: product.category } }"
          class="transition-colors hover:text-text-primary"
        >
          {{ categoryLabel }}
        </RouterLink>
        <span class="mx-2 text-text-muted">/</span>
        <span class="text-text-primary">{{ product.title }}</span>
      </nav>

      <div class="grid gap-10 lg:grid-cols-2 lg:gap-16">
        <!-- Gallery -->
        <div>
          <div class="overflow-hidden rounded-card border border-border-hairline bg-surface-2">
            <img
              :src="gallery[active] ?? product.media.heroImage"
              :alt="product.title"
              width="900"
              height="675"
              class="aspect-[4/3] w-full object-cover"
            />
          </div>

          <p v-if="creditFor" class="mt-2 text-xs text-text-muted">
            Photo:
            <a
              :href="creditFor.sourceUrl"
              target="_blank"
              rel="noopener noreferrer"
              class="underline transition-colors hover:text-text-secondary"
            >
              {{ creditFor.photographer }}
            </a>
            · {{ creditFor.source }}<template v-if="creditFor.licence"> · {{ creditFor.licence }}</template>
          </p>

          <div v-if="gallery.length > 1" class="mt-3 flex flex-wrap gap-3">
            <button
              v-for="(src, index) in gallery"
              :key="src"
              type="button"
              class="overflow-hidden rounded border-2 transition-colors"
              :class="index === active ? 'border-accent' : 'border-border-hairline hover:border-border-strong'"
              :aria-label="`View image ${index + 1}`"
              :aria-pressed="index === active"
              @click="active = index"
            >
              <img :src="src" alt="" width="96" height="72" class="h-18 w-24 object-cover" />
            </button>
          </div>
        </div>

        <!-- Buy box -->
        <!-- Keyed: its chosen finish and quantity belong to one product. -->
        <BuyBox :key="product.id" :product="product" />
      </div>

      <!-- Specs -->
      <section class="mt-16 border-t border-border-hairline pt-10">
        <h2 class="text-xl font-bold">Tech specs</h2>
        <dl class="mt-5 grid gap-x-12 gap-y-0 sm:grid-cols-2">
          <div
            v-for="spec in product.specs"
            :key="spec.label"
            class="flex justify-between gap-6 border-b border-border-hairline py-3 text-sm"
          >
            <dt class="shrink-0 text-text-secondary">{{ spec.label }}</dt>
            <dd class="text-right font-medium">{{ spec.value }}</dd>
          </div>
          <div class="flex justify-between gap-6 border-b border-border-hairline py-3 text-sm">
            <dt class="shrink-0 text-text-secondary">Model number</dt>
            <dd class="code text-right">{{ product.sku }}</dd>
          </div>
        </dl>
      </section>
    </div>

    <!-- Teardown, for the one product that has it -->
    <DeconstructedFlagship v-if="hasTeardown" />

    <!-- Related -->
    <section v-if="related.length" class="mx-auto max-w-[1600px] px-4 py-12 md:px-8 md:py-16">
      <h2 class="mb-6 text-xl font-bold">More in {{ categoryLabel }}</h2>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <ProductCard v-for="item in related" :key="item.id" :product="item" />
      </div>
    </section>
  </div>
</template>
