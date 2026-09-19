<script setup lang="ts">
import { RouterLink } from 'vue-router'
</script>

<template>
  <section class="mx-auto flex min-h-[70vh] max-w-xl flex-col items-center justify-center px-4 text-center">
    <p class="text-sm font-medium text-accent">404</p>
    <h1 class="mt-2 text-3xl font-bold md:text-4xl">We couldn't find that page</h1>
    <p class="mt-3 text-text-secondary">
      The link may be out of date, or the product is no longer stocked.
    </p>
    <div class="mt-8 flex gap-3">
      <RouterLink to="/" class="btn-primary">Back to home</RouterLink>
      <RouterLink to="/shop" class="btn-secondary">Browse all products</RouterLink>
    </div>
  </section>
</template>
