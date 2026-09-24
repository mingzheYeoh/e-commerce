<script setup lang="ts">
// Shared by every signed-in page: identity plus sign-out, per the plan. Each
// page keeps its own page-specific heading below this.
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { me, signOut } from '../api'

const router = useRouter()
const name = ref('Platform')

onMounted(async () => {
  const { body } = await me()
  if (body.kind === 'active' && body.scope === 'merchant') name.value = body.merchant.name
})

async function logout() {
  await signOut()
  await router.push('/')
}
</script>

<template>
  <header class="mb-8 flex items-center justify-between border-b border-border-hairline pb-4">
    <span class="font-display text-lg font-bold text-text-primary">{{ name }}</span>
    <button class="btn-ghost" @click="logout">Sign out</button>
  </header>
</template>
