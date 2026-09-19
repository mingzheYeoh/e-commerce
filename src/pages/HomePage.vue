<script setup lang="ts">
import HeroViewport from '@/components/sections/HeroViewport.vue'
import CategoryLaunchpad from '@/components/sections/CategoryLaunchpad.vue'
import FeaturedRail from '@/components/sections/FeaturedRail.vue'
import BrandMatrix from '@/components/sections/BrandMatrix.vue'
import PromoFeature from '@/components/sections/PromoFeature.vue'
</script>

<template>
  <!-- Home sends people onward: one promise, the four departments, a curated
       eight, the brand roster, and one feature. Browsing and filtering live on
       /shop; the teardown lives on the product page. -->
  <HeroViewport />
  <CategoryLaunchpad />
  <FeaturedRail />
  <BrandMatrix />
  <PromoFeature />
</template>
