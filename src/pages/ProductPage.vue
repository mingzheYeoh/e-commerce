<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import BuyBox from '@/components/commerce/BuyBox.vue'
import ProductCard from '@/components/commerce/ProductCard.vue'
import DeconstructedFlagship from '@/components/sections/DeconstructedFlagship.vue'
import NotFoundPage from './NotFoundPage.vue'
import { products } from '@/data/products'
import { categories } from '@/data/categories'
import { flagship } from '@/data/flagship'

const props = defineProps<{ id: string }>()

const product = computed(() => products.find((p) => p.id === props.id))

const gallery = computed(() => {
  if (!product.value) return []
  return [product.value.media.heroImage, product.value.media.hoverImage].filter(
    (src): src is string => Boolean(src),
  )
})

const active = ref(0)
watch(() => props.id, () => (active.value = 0))

const categoryLabel = computed(
  () => categories.find((c) => c.id === product.value?.category)?.label ?? 'Shop',
)

/** Only one product has teardown geometry; everything else gets a normal page. */
const hasTeardown = computed(() => product.value?.sku === flagship.sku)

const related = computed(() =>
  products
    .filter((p) => p.category === product.value?.category && p.id !== product.value?.id)
    .slice(0, 4),
)
</script>

<template>
  <NotFoundPage v-if="!product" />

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
              :src="gallery[active]"
              :alt="product.title"
              width="900"
              height="675"
              class="aspect-[4/3] w-full object-cover"
            />
          </div>

          <div v-if="gallery.length > 1" class="mt-3 flex gap-3">
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
        <BuyBox :product="product" />
      </div>

      <!-- Specs -->
      <section class="mt-16 border-t border-border-hairline pt-10">
        <h2 class="text-xl font-bold">Specifications</h2>
        <dl class="mt-5 grid gap-x-10 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
          <div
            v-for="(spec, index) in product.specsSummary"
            :key="spec"
            class="flex justify-between gap-4 border-b border-border-hairline pb-3 text-sm"
          >
            <dt class="text-text-secondary">Feature {{ index + 1 }}</dt>
            <dd class="text-right font-medium">{{ spec }}</dd>
          </div>
          <div class="flex justify-between gap-4 border-b border-border-hairline pb-3 text-sm">
            <dt class="text-text-secondary">SKU</dt>
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
