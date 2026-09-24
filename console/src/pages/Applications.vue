<script setup lang="ts">
// Placeholder so the guard has somewhere to land a signed-in platform admin.
// Task 2 replaces the body with the pending-applicants table and Approve flow.
import { useRouter } from 'vue-router'
import { signOut } from '../api'

const router = useRouter()

async function logout() {
  await signOut()
  await router.push('/')
}
</script>

<template>
  <div class="mx-auto max-w-4xl px-6 py-10">
    <header class="mb-8 flex items-center justify-between">
      <h1 class="font-display text-2xl font-bold text-text-primary">Platform admin</h1>
      <button class="btn-ghost" @click="logout">Sign out</button>
    </header>
    <p class="text-text-secondary">Pending applications arrive next.</p>
  </div>
</template>
