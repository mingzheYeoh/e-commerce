<script setup lang="ts">
// Placeholder so the guard has somewhere to land a signed-in merchant.
// Task 2 replaces the body with the product table, form and status editing.
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { me, signOut } from '../api'

const router = useRouter()
const name = ref('')

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
  <div class="mx-auto max-w-4xl px-6 py-10">
    <header class="mb-8 flex items-center justify-between">
      <h1 class="font-display text-2xl font-bold text-text-primary">{{ name || 'Products' }}</h1>
      <button class="btn-ghost" @click="logout">Sign out</button>
    </header>
    <p class="text-text-secondary">Product management arrives next.</p>
  </div>
</template>
