<script setup lang="ts">
import NavBar from '@/components/layout/NavBar.vue'
import CartDrawer from '@/components/layout/CartDrawer.vue'
import SearchPalette from '@/components/layout/SearchPalette.vue'
import HeroViewport from '@/components/sections/HeroViewport.vue'
 import { useLenis } from '@/composables/useLenis'

useLenis()
</script>

<template>
  <a
    href="#main"
    class="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:border focus:border-accent-cyan focus:bg-void focus:px-4 focus:py-2 focus:font-mono focus:text-xs"
  >
    SKIP TO CONTENT
  </a>

  <NavBar />
  <SearchPalette />
  <CartDrawer />

  <main id="main" class="bg-void">
    <HeroViewport />
  </main>
</template>
