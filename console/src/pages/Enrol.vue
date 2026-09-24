<script setup lang="ts">
/**
 * First-time TOTP setup.
 *
 * Every sign-in starts 'enrolling', including an account that already
 * confirmed an authenticator — so this page always tries `begin` first, and
 * a 409 ("already set up") is not an error to show, it is the signal that
 * this session belongs on /verify instead.
 */
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import QRCode from 'qrcode'
import { totpBegin, totpConfirm, signOut, isError } from '../api'

const router = useRouter()
const secret = ref('')
const qr = ref('')
const code = ref('')
const error = ref<string | null>(null)
const loading = ref(true)
const confirming = ref(false)

onMounted(async () => {
  const { status, body } = await totpBegin()
  if (status === 409) {
    await router.replace('/verify')
    return
  }
  if (isError(body)) {
    error.value = body.error
  } else {
    secret.value = body.secret
    qr.value = await QRCode.toDataURL(body.uri, { margin: 1 })
  }
  loading.value = false
})

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
    <h1 class="mb-2 font-display text-2xl font-bold text-text-primary">Set up your authenticator</h1>
    <p class="mb-6 text-sm text-text-secondary">
      Scan this with an authenticator app, or type the secret in by hand if it cannot scan.
    </p>

    <p v-if="loading" class="text-text-secondary">Loading…</p>

    <div v-else class="card flex flex-col items-center gap-4 p-6">
      <img
        v-if="qr"
        :src="qr"
        alt="Scan this QR code with an authenticator app"
        class="h-48 w-48 rounded bg-white p-2"
      />
      <p v-if="secret" class="code text-center text-sm">{{ secret }}</p>

      <form v-if="secret" class="flex w-full flex-col gap-3" @submit.prevent="submit">
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

      <p v-else-if="error" class="text-sm text-accent-amber">{{ error }}</p>
    </div>

    <button class="mt-6 text-sm text-text-secondary underline" type="button" @click="leave">
      Not now — sign out
    </button>
  </div>
</template>
