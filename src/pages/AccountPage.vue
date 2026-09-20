<script setup lang="ts">
/**
 * One page for the whole account: signing in, signing up, and what an account
 * is for once you have one.
 *
 * Two pages would mean two forms that differ by a single field and a shopper
 * bouncing between them after typing the wrong one. The toggle keeps what has
 * already been typed, which is the actual complaint about separate pages.
 */
import { computed, onMounted, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { User, LogOut, Package, AlertCircle, MailCheck } from 'lucide-vue-next'
import { useAuthStore } from '@/stores/auth'
import { useCurrency } from '@/composables/useCurrency'
import { myOrders, type AccountOrder } from '@/lib/api'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()
const { format } = useCurrency()

const mode = ref<'in' | 'up'>('in')
const name = ref('')
const email = ref('')
const password = ref('')

const orders = ref<AccountOrder[] | null>(null)
const loadingOrders = ref(false)

/**
 * Where to go after signing in.
 *
 * Checked rather than followed: a `?next=` that can name any URL is an open
 * redirect, which is how a convincing phishing link gets to borrow this
 * domain's good name. Only a path on this site is allowed, and `//evil.com`
 * is a path to a browser but a host to a human, so it is refused too.
 */
const next = computed(() => {
  const raw = String(route.query.next ?? '')
  return raw.startsWith('/') && !raw.startsWith('//') ? raw : ''
})

async function loadOrders() {
  loadingOrders.value = true
  orders.value = await myOrders()
  loadingOrders.value = false
}

onMounted(async () => {
  if (auth.status === 'unknown') await auth.hydrate()
  if (auth.signedIn) void loadOrders()
})

async function submit() {
  const ok =
    mode.value === 'up'
      ? await auth.register(name.value, email.value, password.value)
      : await auth.login(email.value, password.value)
  if (!ok) return

  password.value = ''
  // Registering leaves a notice and no session — the account is not usable
  // until the emailed link is clicked — so there is nowhere to go yet.
  if (!auth.signedIn) return

  if (next.value) {
    router.replace(next.value)
    return
  }
  void loadOrders()
}

async function leave() {
  await auth.logout()
  orders.value = null
}

const PAYMENT_LABEL: Record<string, string> = {
  succeeded: 'Paid',
  card_declined: 'Declined',
  insufficient_funds: 'Declined',
  expired_card: 'Declined',
}

const when = (iso: string) =>
  new Date(iso.replace(' ', 'T') + (iso.includes('Z') ? '' : 'Z')).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
</script>

<template>
  <div class="pt-16">
    <div class="mx-auto max-w-[1600px] px-4 py-10 md:px-8 md:py-14">
      <!-- ------------------------------------------------------ signed in -->
      <template v-if="auth.signedIn && auth.user">
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 class="text-2xl font-bold md:text-3xl">Hello, {{ auth.firstName }}</h1>
            <p class="mt-1 text-sm text-text-secondary">{{ auth.user.email }}</p>
          </div>
          <button type="button" class="btn-ghost inline-flex items-center gap-2" @click="leave">
            <LogOut class="h-3.5 w-3.5" aria-hidden="true" />
            Sign out
          </button>
        </div>

        <h2 class="mt-10 flex items-center gap-2 font-semibold">
          <Package class="h-4 w-4 text-text-secondary" aria-hidden="true" />
          Your orders
        </h2>

        <p v-if="loadingOrders" class="mt-4 text-sm text-text-secondary">Looking them up…</p>

        <!--
          An account lists the orders placed while signed in, and says so.
          Orders are joined by the account that placed them, never by matching
          the email on them — email here is unverified, so a join on it would
          hand anyone who registers an address someone else's order history.
        -->
        <p v-else-if="!orders?.length" class="mt-4 max-w-lg text-sm text-text-secondary">
          Nothing here yet. Orders you place while signed in will appear on this page, on any
          device — orders placed signed out stay on the browser that made them, reachable by their
          own link.
        </p>

        <ul v-else class="mt-4 divide-y divide-border-hairline rounded-card border border-border-hairline">
          <li v-for="order in orders" :key="order.id" class="flex flex-wrap items-center gap-x-6 gap-y-2 p-4">
            <RouterLink :to="`/order/${order.id}`" class="code font-semibold hover:text-accent">
              {{ order.id }}
            </RouterLink>
            <span class="text-sm text-text-secondary">{{ when(order.placedAt) }}</span>
            <span class="nums text-sm text-text-secondary">
              {{ order.itemCount }} item{{ order.itemCount === 1 ? '' : 's' }}
            </span>
            <span
              class="rounded-full px-2 py-0.5 text-xs"
              :class="
                order.paymentCode === 'succeeded'
                  ? 'bg-accent-green/15 text-accent-green'
                  : 'bg-accent-red/15 text-accent-red'
              "
            >
              {{ PAYMENT_LABEL[order.paymentCode] ?? order.paymentCode }}
            </span>
            <span class="nums ml-auto font-semibold">{{ format(order.total) }}</span>
          </li>
        </ul>
      </template>

      <!-- ----------------------------------------------------- signed out -->
      <div v-else class="mx-auto max-w-md">
        <h1 class="flex items-center gap-2 text-2xl font-bold">
          <User class="h-5 w-5 text-text-secondary" aria-hidden="true" />
          {{ mode === 'up' ? 'Create an account' : 'Sign in' }}
        </h1>
        <p class="mt-2 text-sm text-text-secondary">
          An account keeps your orders together and readable from any device. Checkout works
          perfectly well without one.
        </p>

        <!--
          After a registration there is nothing to sign into yet, so the form
          steps aside for the one instruction that matters. It says the same
          thing whether the address was free or already had an account — which
          of the two happened is in the inbox, not on this page.
        -->
        <div
          v-if="auth.notice"
          class="mt-8 rounded-card border border-accent-green/30 bg-accent-green/5 p-5"
          role="status"
        >
          <p class="flex items-start gap-2 text-sm font-medium text-accent-green">
            <MailCheck class="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            {{ auth.notice }}
          </p>
          <p class="mt-2 text-xs text-text-secondary">
            Sent to <span class="font-medium text-text-primary">{{ email }}</span>. The link is good
            for 24 hours. Nothing arrives? Check spam, then try again in a minute.
          </p>
        </div>

        <form v-else class="mt-8 space-y-4" @submit.prevent="submit">
          <label v-if="mode === 'up'" class="block">
            <span class="mb-1.5 block text-sm text-text-secondary">Full name</span>
            <input v-model="name" required autocomplete="name" class="input" />
          </label>

          <label class="block">
            <span class="mb-1.5 block text-sm text-text-secondary">Email</span>
            <input v-model="email" type="email" required autocomplete="email" class="input" />
          </label>

          <label class="block">
            <span class="mb-1.5 block text-sm text-text-secondary">Password</span>
            <input
              v-model="password"
              type="password"
              required
              minlength="8"
              :autocomplete="mode === 'up' ? 'new-password' : 'current-password'"
              class="input"
            />
            <span v-if="mode === 'up'" class="mt-1.5 block text-xs text-text-muted">
              At least 8 characters.
            </span>
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
            {{ auth.busy ? 'One moment…' : mode === 'up' ? 'Create account' : 'Sign in' }}
          </button>
        </form>

        <p v-if="!auth.notice" class="mt-6 text-sm text-text-secondary">
          {{ mode === 'up' ? 'Already have an account?' : 'New here?' }}
          <button
            type="button"
            class="text-accent underline"
            @click="((mode = mode === 'up' ? 'in' : 'up'), (auth.error = ''))"
          >
            {{ mode === 'up' ? 'Sign in' : 'Create one' }}
          </button>
        </p>

        <p class="mt-8 border-t border-border-hairline pt-6 text-xs text-text-muted">
          This is a demonstration store. Use a password you do not use anywhere else — it is
          hashed and salted before storage, but a demo is not where your real one belongs.
        </p>
      </div>
    </div>
  </div>
</template>
