<script setup lang="ts">
import { useRoute } from 'vue-router'
import DashboardLayout from './components/DashboardLayout.vue'

const route = useRoute()
</script>

<template>
  <DashboardLayout v-if="route.meta.shell" :scope="route.meta.shell">
    <router-view />
  </DashboardLayout>
  <router-view v-else />
</template>
