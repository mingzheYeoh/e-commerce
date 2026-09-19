<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { ArrowRight } from 'lucide-vue-next'
import { flagship } from '@/data/flagship'
import { products } from '@/data/products'
import { brandName } from '@/data/brands'
import { useCurrency } from '@/composables/useCurrency'

const { formatPrice } = useCurrency()
const target = products.find((p) => p.sku === flagship.sku)
</script>

<template>
  <section v-if="target" class="border-t border-border-hairline bg-void py-16 md:py-20">
    <div class="mx-auto max-w-[1600px] px-4 md:px-8">
      <RouterLink
        :to="`/product/${target.id}`"
        class="card group grid gap-0 overflow-hidden transition-colors hover:border-border-strong md:grid-cols-2"
      >
        <div class="relative aspect-[16/10] overflow-hidden bg-surface-2 md:aspect-auto">
          <img
            :src="flagship.image"
            :alt="flagship.title"
            width="800"
            height="600"
            loading="lazy"
            class="absolute inset-0 h-full w-full object-cover transition-transform duration-700 group-hover:scale-[1.03]"
          />
        </div>

        <div class="flex flex-col justify-center gap-4 p-6 md:p-12">
          <p class="text-sm font-medium text-accent">Featured product</p>
          <h2 class="text-2xl font-bold md:text-4xl">
            {{ brandName(flagship.brand) }} {{ flagship.title }}
          </h2>
          <p class="text-text-secondary">
            An open-back reference headphone, built from a machined aluminium yoke and a 38mm
            dynamic transducer. Take it apart component by component on the product page.
          </p>
          <p class="nums text-xl font-semibold">{{ formatPrice(flagship.price) }}</p>
          <span class="flex items-center gap-1.5 text-sm font-medium text-accent">
            Explore the teardown
            <ArrowRight class="h-4 w-4 transition-transform group-hover:translate-x-1" aria-hidden="true" />
          </span>
        </div>
      </RouterLink>
    </div>
  </section>
</template>
