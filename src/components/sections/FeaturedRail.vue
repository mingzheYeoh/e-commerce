<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { ArrowRight } from 'lucide-vue-next'
import ProductCard from '@/components/commerce/ProductCard.vue'
import { catalogue } from '@/stores/catalog'

/**
 * A curated eight, not the catalogue. Badged products lead — that is what "new
 * arrivals" means to a shopper — then the best rated fill the rest.
 */
const featured = computed(() => {
  const badged = catalogue.value.filter((p) => p.badge && p.inStock)
  const rest = catalogue.value
    .filter((p) => !p.badge && p.inStock)
    .sort((a, b) => b.rating - a.rating)
  return [...badged, ...rest].slice(0, 8)
})
</script>

<template>
  <section class="border-t border-border-hairline bg-void py-16 md:py-20">
    <div class="mx-auto max-w-[1600px] px-4 md:px-8">
      <div class="mb-8 flex items-end justify-between gap-6">
        <div>
          <h2 class="text-2xl font-bold md:text-4xl">New arrivals</h2>
          <p class="mt-2 text-sm text-text-secondary md:text-base">
            Just landed from our authorised partners.
          </p>
        </div>
        <RouterLink
          to="/shop"
          class="hidden shrink-0 items-center gap-1.5 text-sm font-medium text-accent transition-colors hover:text-accent-hover md:flex"
        >
          View all {{ catalogue.length }} products
          <ArrowRight class="h-4 w-4" aria-hidden="true" />
        </RouterLink>
      </div>

      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <ProductCard v-for="product in featured" :key="product.id" :product="product" />
      </div>

      <RouterLink to="/shop" class="btn-secondary mt-6 block text-center md:hidden">
        View all {{ catalogue.length }} products
      </RouterLink>
    </div>
  </section>
</template>
