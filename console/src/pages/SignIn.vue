<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { signIn, isError } from '../api'

const router = useRouter()
const email = ref('')
const password = ref('')
const error = ref<string | null>(null)
const submitting = ref(false)

async function submit() {
  error.value = null
  submitting.value = true
  try {
    const { body } = await signIn({ email: email.value, password: password.value })
    // Every sign-in lands in 'enrolling', confirmed or not — routing there is
    // the guard's job, not this page's, so it just re-resolves at '/'.
    if (isError(body)) error.value = body.error
    else await router.push('/')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
    <h1 class="mb-6 font-display text-2xl font-bold text-text-primary">Sign in</h1>

    <form class="card flex flex-col gap-4 p-6" @submit.prevent="submit">
      <div>
        <label class="label mb-1 block" for="signin-email">Email</label>
        <input id="signin-email" v-model="email" class="input" type="email" required />
      </div>
      <div>
        <label class="label mb-1 block" for="signin-password">Password</label>
        <input id="signin-password" v-model="password" class="input" type="password" required />
      </div>
      <p v-if="error" class="text-sm text-accent-amber">{{ error }}</p>
      <button class="btn-primary" type="submit" :disabled="submitting">
        {{ submitting ? 'Signing in…' : 'Sign in' }}
      </button>
      <router-link to="/apply" class="btn-ghost text-center">Apply to sell on NEXUS</router-link>
    </form>
  </div>
</template>
