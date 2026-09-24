<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { totpConfirm, signOut, isError } from '../api'

const router = useRouter()
const code = ref('')
const error = ref<string | null>(null)
const confirming = ref(false)

async function submit() {
  error.value = null
  confirming.value = true
  try {
    const { body } = await totpConfirm(code.value)
    if (isError(body)) error.value = body.error
    else await router.push('/')
  } finally {
    confirming.value = false
  }
}

/* Someone who stops halfway — wrong account, phone not to hand — must be able
   to walk away; every other page redirects an enrolling session back here. */
async function leave() {
  await signOut()
  await router.replace('/signin')
}
</script>

<template>
  <div class="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
    <h1 class="mb-2 font-display text-2xl font-bold text-text-primary">Enter your code</h1>
    <p class="mb-6 text-sm text-text-secondary">Open your authenticator app and enter the current code.</p>

    <form class="card flex flex-col gap-3 p-6" @submit.prevent="submit">
      <input
        v-model="code"
        class="input text-center tracking-[0.3em]"
        inputmode="numeric"
        maxlength="6"
        placeholder="000000"
        required
        autofocus
      />
      <p v-if="error" class="text-sm text-accent-amber">{{ error }}</p>
      <button class="btn-primary" type="submit" :disabled="confirming">
        {{ confirming ? 'Checking…' : 'Confirm' }}
      </button>
    </form>

    <button class="mt-6 text-sm text-text-secondary underline" type="button" @click="leave">
      Not now — sign out
    </button>
  </div>
</template>
