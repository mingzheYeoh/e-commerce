<script setup lang="ts">
import { ref } from 'vue'
import { register, isError } from '../api'

const name = ref('')
const email = ref('')
const password = ref('')
const submitting = ref(false)
const error = ref<string | null>(null)
const done = ref(false)

async function submit() {
  error.value = null
  submitting.value = true
  try {
    const { body } = await register({ name: name.value, email: email.value, password: password.value })
    if (isError(body)) error.value = body.error
    else done.value = true
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
    <h1 class="mb-6 font-display text-2xl font-bold text-text-primary">Sell on NEXUS</h1>

    <div v-if="done" class="card p-6">
      <p class="text-text-primary">
        Your application is with our team for review. There is no confirmation email by design — you
        will know you have been approved when signing in works.
      </p>
      <router-link to="/signin" class="btn-secondary mt-6 inline-block">Back to sign in</router-link>
    </div>

    <form v-else class="card flex flex-col gap-4 p-6" @submit.prevent="submit">
      <div>
        <label class="label mb-1 block" for="apply-name">Business name</label>
        <input id="apply-name" v-model="name" class="input" type="text" required maxlength="120" />
      </div>
      <div>
        <label class="label mb-1 block" for="apply-email">Email</label>
        <input id="apply-email" v-model="email" class="input" type="email" required maxlength="200" />
      </div>
      <div>
        <label class="label mb-1 block" for="apply-password">Password</label>
        <input
          id="apply-password"
          v-model="password"
          class="input"
          type="password"
          required
          minlength="12"
        />
      </div>
      <p v-if="error" class="text-sm text-accent-amber">{{ error }}</p>
      <button class="btn-primary" type="submit" :disabled="submitting">
        {{ submitting ? 'Sending…' : 'Apply' }}
      </button>
      <router-link to="/signin" class="btn-ghost text-center"
        >Already have an account? Sign in</router-link
      >
    </form>
  </div>
</template>
