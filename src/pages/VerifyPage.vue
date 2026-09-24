<script setup lang="ts">
/**
 * Where a verification link lands.
 *
 * The link points here rather than straight at the API, and this page POSTs.
 * Mail scanners, link previewers and corporate security gateways all follow
 * GET links before a human sees the message — a one-shot token in a GET is a
 * token spent by an appliance, and the recipient gets "already used".
 *
 * The token is removed from the URL as soon as it has been read. It is a
 * credential for one use, and leaving it in the address bar puts it into
 * browser history, the referrer of anything this page loads, and whatever the
 * shopper pastes when they ask someone why it did not work.
 */
import { onMounted, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { CheckCircle2, AlertCircle } from 'lucide-vue-next'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

const state = ref<'working' | 'done' | 'failed'>('working')

onMounted(async () => {
  const token = String(route.query.token ?? '')
  if (!token) {
    state.value = 'failed'
    auth.error = 'That link is missing its code. Open the most recent email and try again.'
    return
  }

  router.replace({ path: '/verify' })
  state.value = (await auth.confirm(token)) ? 'done' : 'failed'
})
</script>

<template>
  <div class="pt-16">
    <div class="mx-auto max-w-md px-4 py-16 text-center md:py-24">
      <p v-if="state === 'working'" class="text-text-secondary">Confirming your email…</p>

      <template v-else-if="state === 'done'">
        <CheckCircle2 class="mx-auto h-10 w-10 text-accent-green" aria-hidden="true" />
        <h1 class="mt-4 text-2xl font-bold">You're all set, {{ auth.firstName }}</h1>
        <p class="mt-2 text-sm text-text-secondary">
          Your email is confirmed and you are signed in on this device.
        </p>
        <div class="mt-8 flex flex-wrap justify-center gap-3">
          <RouterLink to="/account" class="btn-primary">Go to your account</RouterLink>
          <RouterLink to="/shop" class="btn-ghost">Start shopping</RouterLink>
        </div>
      </template>

      <template v-else>
        <AlertCircle class="mx-auto h-10 w-10 text-accent-red" aria-hidden="true" />
        <h1 class="mt-4 text-2xl font-bold">That link did not work</h1>
        <p class="mt-2 text-sm text-text-secondary">{{ auth.error }}</p>
        <!-- Registering again with the same address sends a fresh link and
             says nothing different, so it is the whole recovery path. -->
        <RouterLink to="/account" class="btn-primary mt-8 inline-flex">
          Try signing up again
        </RouterLink>
      </template>
    </div>
  </div>
</template>
