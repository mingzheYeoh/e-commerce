<script setup lang="ts">
import NavBar from '@/components/layout/NavBar.vue'
import CartDrawer from '@/components/layout/CartDrawer.vue'
import SearchPalette from '@/components/layout/SearchPalette.vue'
import CompareTray from '@/components/commerce/CompareTray.vue'
import SiteFooter from '@/components/layout/SiteFooter.vue'
import { onMounted } from 'vue'
import { useCompareStore } from '@/stores/compare'
import { useAuthStore } from '@/stores/auth'
import { useCatalogStore } from '@/stores/catalog'
import { useLenis } from '@/composables/useLenis'
import { useReducedMotion } from '@/composables/useReducedMotion'

useReducedMotion()
useLenis()

/*
 * Asked once, after the first paint. The session is an HttpOnly cookie, so
 * whether anyone is signed in is a question only the server can answer — and
 * not one worth delaying the storefront for, since the header has already
 * drawn itself from the local hint.
 */
const auth = useAuthStore()
onMounted(() => void auth.hydrate())

/*
 * Revalidate the baked catalogue snapshot against the live one, once the
 * static page has already painted from it. A failed or slow fetch leaves the
 * snapshot in place - see catalog.ts's refresh().
 */
const catalog = useCatalogStore()
onMounted(() => void catalog.refresh())

// The comparison tray is fixed, so it cannot push anything out of its way. The
// footer has to be told to get out of the way instead.
const compare = useCompareStore()
</script>

<template>
  <a
    href="#main"
    class="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded focus:border focus:border-accent focus:bg-void focus:px-4 focus:py-2 focus:text-sm focus:font-medium"
  >
    Skip to content
  </a>

  <NavBar />
  <SearchPalette />
  <CartDrawer />

  <main id="main" class="min-h-screen bg-void">
    <RouterView />
  </main>

  <SiteFooter :class="compare.ids.length && 'pb-20'" />

  <!-- Docked last so it sits above the footer on a short page. -->
  <CompareTray />
</template>
