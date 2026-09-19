<script setup lang="ts">
import { RouterLink } from 'vue-router'
import AskPanel from '@/components/commerce/AskPanel.vue'
import { products } from '@/data/products'
</script>

<template>
  <div class="pt-16">
    <div class="mx-auto max-w-[1600px] px-4 py-10 md:px-8 md:py-16">
      <nav class="mb-8 text-sm text-text-secondary" aria-label="Breadcrumb">
        <RouterLink to="/" class="transition-colors hover:text-text-primary">Home</RouterLink>
        <span class="mx-2 text-text-muted">/</span>
        <span class="text-text-primary">Ask</span>
      </nav>

      <header class="mb-8 max-w-2xl">
        <h1 class="text-3xl font-bold md:text-4xl">Ask about the catalogue</h1>
        <p class="mt-3 text-text-secondary">
          Questions are answered from the published specifications of all
          {{ products.length }} products — charging speeds, ports, battery figures, what pairs with
          what. Every claim links to the product it came from, and anything the catalogue does not
          cover is declined rather than guessed at.
        </p>
      </header>

      <AskPanel />
    </div>
  </div>
</template>
