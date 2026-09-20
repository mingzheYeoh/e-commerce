<script setup lang="ts">
/**
 * Where a password-reset link lands.
 *
 * Same shape as the verification page and for the same reasons: the link
 * carries a one-shot credential, so the token is lifted out of the URL before
 * anything else happens, and it is spent by a POST the shopper triggers rather
 * than by the GET that a mail scanner would follow.
 *
 * Unlike verification, this one has a form in the middle — the token alone is
 * not the goal, the new password is.
 */
import { onMounted, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { CheckCircle2, AlertCircle, KeyRound } from 'lucide-vue-next'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

const token = ref('')
const password = ref('')
const state = ref<'ready' | 'done' | 'failed'>('ready')

onMounted(() => {
  const raw = String(route.query.token ?? '')
  if (!raw) {
    state.value = 'failed'
    auth.error = 'That link is missing its code. Open the most recent email and try again.'
    return
  }
  token.value = raw
  // Out of the address bar before it can reach browser history, a referrer, or
  // whatever gets pasted into a message asking why this did not work.
  router.replace({ path: '/reset' })
})

async function submit() {
  state.value = (await auth.reset(token.value, password.value)) ? 'done' : 'failed'
  password.value = ''
}
</script>

<template>
  <div class="pt-16">
    <div class="mx-auto max-w-md px-4 py-16 md:py-24">
      <template v-if="state === 'done'">
        <div class="text-center">
          <CheckCircle2 class="mx-auto h-10 w-10 text-accent-green" aria-hidden="true" />
          <h1 class="mt-4 text-2xl font-bold">Password changed</h1>
          <!-- Worth saying plainly: the reset is what makes it a reset. -->
          <p class="mt-2 text-sm text-text-secondary">
            You are signed in here, and signed out everywhere else.
          </p>
          <RouterLink to="/account" class="btn-primary mt-8 inline-flex">
            Go to your account
          </RouterLink>
        </div>
      </template>

      <template v-else-if="state === 'failed' && !token">
        <div class="text-center">
          <AlertCircle class="mx-auto h-10 w-10 text-accent-red" aria-hidden="true" />
          <h1 class="mt-4 text-2xl font-bold">That link did not work</h1>
          <p class="mt-2 text-sm text-text-secondary">{{ auth.error }}</p>
          <RouterLink to="/account" class="btn-primary mt-8 inline-flex">Ask for a new one</RouterLink>
        </div>
      </template>

      <template v-else>
        <h1 class="flex items-center gap-2 text-2xl font-bold">
          <KeyRound class="h-5 w-5 text-text-secondary" aria-hidden="true" />
          Choose a new password
        </h1>

        <form class="mt-8 space-y-4" @submit.prevent="submit">
          <label class="block">
            <span class="mb-1.5 block text-sm text-text-secondary">New password</span>
            <input
              v-model="password"
              type="password"
              required
              minlength="8"
              autocomplete="new-password"
              class="input"
            />
            <span class="mt-1.5 block text-xs text-text-muted">At least 8 characters.</span>
          </label>

          <p
            v-if="auth.error"
            class="flex items-start gap-2 rounded border border-accent-red/30 bg-accent-red/5 p-3 text-sm text-accent-red"
            role="alert"
          >
            <AlertCircle class="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            {{ auth.error }}
          </p>

          <button type="submit" class="btn-primary w-full" :disabled="auth.busy">
            {{ auth.busy ? 'One moment…' : 'Set new password' }}
          </button>
        </form>

        <p class="mt-6 text-xs text-text-muted">
          Setting a new password ends every other session on your account — including one someone
          else may be holding, which is usually why a password gets reset.
        </p>
      </template>
    </div>
  </div>
</template>
