<script setup lang="ts">
/**
 * The settings on an account: password, address, devices, second factor, and
 * the way out.
 *
 * Every one of them asks for the current password again. A live session says a
 * browser was signed in once; it does not say who is at the keyboard now, and
 * an unlocked laptop is the whole attack. Four seconds for a returning owner,
 * everything for somebody who sat down at their desk.
 *
 * Each panel keeps its own busy flag and its own message, so a failure in one
 * does not blank the others — these get used one at a time, and a page-wide
 * error bar would put the answer nowhere near the question.
 */
import { ref, onMounted } from 'vue'
import { KeyRound, Mail, MonitorSmartphone, ShieldCheck, Trash2, Copy, Check } from 'lucide-vue-next'
import {
  fetchSettings,
  changePassword,
  changeEmail,
  revokeOtherSessions,
  closeAccount,
  startTwoFactor,
  confirmTwoFactor,
  disableTwoFactor,
  type AccountSettings,
} from '@/lib/api'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const settings = ref<AccountSettings | null>(null)

type PanelState = { busy: boolean; error: string; done: string }
const blank = (): PanelState => ({ busy: false, error: '', done: '' })

const password = ref(blank())
const email = ref(blank())
const devices = ref(blank())
const twoFactor = ref(blank())
const closing = ref(blank())

const currentPassword = ref('')
const nextPassword = ref('')
const emailPassword = ref('')
const nextEmail = ref('')
const twoFactorPassword = ref('')
const twoFactorCode = ref('')
const closePassword = ref('')
const confirmClose = ref(false)

/** Shown once, after enrolment. Nobody can show them again, including us. */
const recoveryCodes = ref<string[] | null>(null)
const enrolment = ref<{ secret: string; uri: string } | null>(null)
const copied = ref(false)

async function refresh() {
  settings.value = await fetchSettings()
}

onMounted(refresh)

/** Runs one panel's action and leaves its outcome in that panel. */
async function act(panel: typeof password, run: () => Promise<{ ok: boolean; error?: string; data?: Record<string, unknown> }>) {
  panel.value = { busy: true, error: '', done: '' }
  const result = await run()
  if (!result.ok) {
    panel.value = { busy: false, error: result.error ?? 'Something went wrong.', done: '' }
    return null
  }
  panel.value = { busy: false, error: '', done: String(result.data?.message ?? 'Done.') }
  await refresh()
  return result.data ?? {}
}

async function submitPassword() {
  const data = await act(password, () => changePassword(currentPassword.value, nextPassword.value))
  if (data) {
    currentPassword.value = ''
    nextPassword.value = ''
  }
}

async function submitEmail() {
  const data = await act(email, () => changeEmail(emailPassword.value, nextEmail.value))
  if (data) {
    emailPassword.value = ''
    nextEmail.value = ''
  }
}

const submitDevices = () => act(devices, revokeOtherSessions)

async function beginTwoFactor() {
  const data = await act(twoFactor, () => startTwoFactor(twoFactorPassword.value))
  if (data) {
    enrolment.value = { secret: String(data.secret), uri: String(data.uri) }
    twoFactorPassword.value = ''
    twoFactor.value.done = ''
  }
}

async function finishTwoFactor() {
  const data = await act(twoFactor, () => confirmTwoFactor(twoFactorCode.value))
  if (data) {
    recoveryCodes.value = (data.recoveryCodes as string[]) ?? []
    enrolment.value = null
    twoFactorCode.value = ''
  }
}

async function turnOffTwoFactor() {
  const data = await act(twoFactor, () => disableTwoFactor(twoFactorPassword.value))
  if (data) {
    twoFactorPassword.value = ''
    recoveryCodes.value = null
  }
}

async function submitClose() {
  const data = await act(closing, () => closeAccount(closePassword.value))
  // The server has already cleared the cookie; this clears what the header is
  // drawing from.
  if (data) auth.apply(null)
}

async function copyCodes() {
  try {
    await navigator.clipboard.writeText((recoveryCodes.value ?? []).join('\n'))
    copied.value = true
    window.setTimeout(() => (copied.value = false), 2000)
  } catch {
    /* clipboard access is refused often enough that this cannot be the only
       way to keep them — they are on screen to be written down. */
  }
}
</script>

<template>
  <section v-if="settings" class="mt-12 border-t border-border-hairline pt-10">
    <h2 class="text-lg font-semibold">Settings</h2>

    <div class="mt-6 grid gap-4 lg:grid-cols-2">
      <!-- ------------------------------------------------------- password -->
      <form class="rounded-card border border-border-hairline bg-surface-1 p-5" @submit.prevent="submitPassword">
        <h3 class="flex items-center gap-2 text-sm font-semibold">
          <KeyRound class="h-4 w-4 text-text-secondary" aria-hidden="true" />
          Change password
        </h3>
        <div class="mt-4 space-y-3">
          <label class="block">
            <span class="mb-1.5 block text-xs text-text-secondary">Current password</span>
            <input v-model="currentPassword" type="password" required autocomplete="current-password" class="input" />
          </label>
          <label class="block">
            <span class="mb-1.5 block text-xs text-text-secondary">New password</span>
            <input v-model="nextPassword" type="password" required minlength="8" autocomplete="new-password" class="input" />
          </label>
        </div>
        <p v-if="password.error" class="mt-3 text-xs text-accent-red" role="alert">{{ password.error }}</p>
        <p v-else-if="password.done" class="mt-3 text-xs text-accent-green">{{ password.done }}</p>
        <button type="submit" class="btn-ghost mt-4 w-full" :disabled="password.busy">
          {{ password.busy ? 'One moment…' : 'Change password' }}
        </button>
        <!-- Said out loud, because the two are easy to confuse and they differ
             in exactly this. -->
        <p class="mt-3 text-xs text-text-muted">
          Other devices stay signed in. To end those, use the button below.
        </p>
      </form>

      <!-- ---------------------------------------------------------- email -->
      <form class="rounded-card border border-border-hairline bg-surface-1 p-5" @submit.prevent="submitEmail">
        <h3 class="flex items-center gap-2 text-sm font-semibold">
          <Mail class="h-4 w-4 text-text-secondary" aria-hidden="true" />
          Change email
        </h3>
        <p class="mt-2 text-xs text-text-secondary">
          Currently <span class="text-text-primary">{{ settings.user.email }}</span>.
        </p>
        <p v-if="settings.pendingEmail" class="mt-2 rounded border border-border-hairline bg-surface-2/60 p-2 text-xs text-text-secondary">
          Waiting on a link sent to
          <span class="font-medium text-text-primary">{{ settings.pendingEmail }}</span>.
          Nothing changes until it is clicked.
        </p>
        <div class="mt-4 space-y-3">
          <label class="block">
            <span class="mb-1.5 block text-xs text-text-secondary">New email</span>
            <input v-model="nextEmail" type="email" required autocomplete="email" class="input" />
          </label>
          <label class="block">
            <span class="mb-1.5 block text-xs text-text-secondary">Current password</span>
            <input v-model="emailPassword" type="password" required autocomplete="current-password" class="input" />
          </label>
        </div>
        <p v-if="email.error" class="mt-3 text-xs text-accent-red" role="alert">{{ email.error }}</p>
        <p v-else-if="email.done" class="mt-3 text-xs text-accent-green">{{ email.done }}</p>
        <button type="submit" class="btn-ghost mt-4 w-full" :disabled="email.busy">
          {{ email.busy ? 'One moment…' : 'Send confirmation link' }}
        </button>
      </form>

      <!-- --------------------------------------------------- two factor -->
      <div class="rounded-card border border-border-hairline bg-surface-1 p-5 lg:col-span-2">
        <h3 class="flex items-center gap-2 text-sm font-semibold">
          <ShieldCheck class="h-4 w-4" :class="settings.twoFactor ? 'text-accent-green' : 'text-text-secondary'" aria-hidden="true" />
          Two-factor authentication
          <span v-if="settings.twoFactor" class="rounded-full bg-accent-green/15 px-2 py-0.5 text-xs text-accent-green">On</span>
        </h3>

        <!-- Recovery codes, shown once and never again. -->
        <div v-if="recoveryCodes" class="mt-4 rounded border border-accent-green/30 bg-accent-green/5 p-4">
          <p class="text-sm font-medium text-accent-green">Write these down now.</p>
          <p class="mt-1 text-xs text-text-secondary">
            Each one signs you in once if your phone is gone. They are stored hashed, so this is
            the only time they can be shown — not even we can read them back.
          </p>
          <ul class="code mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
            <li v-for="code in recoveryCodes" :key="code">{{ code }}</li>
          </ul>
          <button type="button" class="btn-ghost mt-4 inline-flex items-center gap-2 text-xs" @click="copyCodes">
            <component :is="copied ? Check : Copy" class="h-3.5 w-3.5" aria-hidden="true" />
            {{ copied ? 'Copied' : 'Copy all' }}
          </button>
        </div>

        <!-- Mid-enrolment: the app has the secret, we need proof it works. -->
        <form v-else-if="enrolment" class="mt-4" @submit.prevent="finishTwoFactor">
          <p class="text-xs text-text-secondary">
            Add this key to your authenticator app, then enter the six digits it shows.
          </p>
          <p class="code mt-3 break-all rounded border border-border-hairline bg-surface-2/60 p-3 text-sm">
            {{ enrolment.secret }}
          </p>
          <p class="mt-2 break-all text-xs text-text-muted">{{ enrolment.uri }}</p>
          <label class="mt-4 block max-w-[12rem]">
            <span class="mb-1.5 block text-xs text-text-secondary">Six-digit code</span>
            <input v-model="twoFactorCode" inputmode="numeric" required class="input nums" placeholder="000000" />
          </label>
          <p v-if="twoFactor.error" class="mt-3 text-xs text-accent-red" role="alert">{{ twoFactor.error }}</p>
          <button type="submit" class="btn-primary mt-4" :disabled="twoFactor.busy">
            {{ twoFactor.busy ? 'Checking…' : 'Turn it on' }}
          </button>
        </form>

        <!-- On: the only thing left is turning it off. -->
        <form v-else-if="settings.twoFactor" class="mt-4 flex flex-wrap items-end gap-3" @submit.prevent="turnOffTwoFactor">
          <p class="w-full text-xs text-text-secondary">
            {{ settings.recoveryCodesLeft }} recovery
            {{ settings.recoveryCodesLeft === 1 ? 'code' : 'codes' }} left.
          </p>
          <label class="block max-w-xs flex-1">
            <span class="mb-1.5 block text-xs text-text-secondary">Current password</span>
            <input v-model="twoFactorPassword" type="password" required autocomplete="current-password" class="input" />
          </label>
          <button type="submit" class="btn-ghost" :disabled="twoFactor.busy">Turn off</button>
          <p v-if="twoFactor.error" class="w-full text-xs text-accent-red" role="alert">{{ twoFactor.error }}</p>
          <p v-else-if="twoFactor.done" class="w-full text-xs text-accent-green">{{ twoFactor.done }}</p>
        </form>

        <!-- Off. -->
        <form v-else class="mt-4 flex flex-wrap items-end gap-3" @submit.prevent="beginTwoFactor">
          <p class="w-full text-xs text-text-secondary">
            A code from your phone on top of your password. You will get recovery codes for the day
            the phone is not there.
          </p>
          <label class="block max-w-xs flex-1">
            <span class="mb-1.5 block text-xs text-text-secondary">Current password</span>
            <input v-model="twoFactorPassword" type="password" required autocomplete="current-password" class="input" />
          </label>
          <button type="submit" class="btn-ghost" :disabled="twoFactor.busy">Set it up</button>
          <p v-if="twoFactor.error" class="w-full text-xs text-accent-red" role="alert">{{ twoFactor.error }}</p>
        </form>
      </div>

      <!-- -------------------------------------------------------- devices -->
      <div class="rounded-card border border-border-hairline bg-surface-1 p-5">
        <h3 class="flex items-center gap-2 text-sm font-semibold">
          <MonitorSmartphone class="h-4 w-4 text-text-secondary" aria-hidden="true" />
          Signed in on {{ settings.sessions }}
          {{ settings.sessions === 1 ? 'device' : 'devices' }}
        </h3>
        <p class="mt-2 text-xs text-text-secondary">
          This one included. Signing the others out does not touch this browser.
        </p>
        <p v-if="devices.error" class="mt-3 text-xs text-accent-red" role="alert">{{ devices.error }}</p>
        <p v-else-if="devices.done" class="mt-3 text-xs text-accent-green">{{ devices.done }}</p>
        <button
          type="button"
          class="btn-ghost mt-4 w-full"
          :disabled="devices.busy || settings.sessions < 2"
          @click="submitDevices"
        >
          {{ devices.busy ? 'One moment…' : 'Sign out other devices' }}
        </button>
      </div>

      <!-- ---------------------------------------------------------- close -->
      <form class="rounded-card border border-accent-red/25 bg-surface-1 p-5" @submit.prevent="submitClose">
        <h3 class="flex items-center gap-2 text-sm font-semibold text-accent-red">
          <Trash2 class="h-4 w-4" aria-hidden="true" />
          Close this account
        </h3>
        <!-- Stated before the button, not after. -->
        <p class="mt-2 text-xs text-text-secondary">
          Your orders are kept — each one is the record of a purchase, with the address it shipped
          to and the price charged. They stop being linked to any account and stay reachable by
          their own order number.
        </p>
        <label class="mt-4 block">
          <span class="mb-1.5 block text-xs text-text-secondary">Current password</span>
          <input v-model="closePassword" type="password" required autocomplete="current-password" class="input" />
        </label>
        <label class="mt-3 flex cursor-pointer items-start gap-2 text-xs text-text-secondary">
          <input v-model="confirmClose" type="checkbox" class="mt-0.5 accent-accent-red" />
          <span>I understand this cannot be undone.</span>
        </label>
        <p v-if="closing.error" class="mt-3 text-xs text-accent-red" role="alert">{{ closing.error }}</p>
        <button
          type="submit"
          class="btn-ghost mt-4 w-full border-accent-red/40 text-accent-red disabled:opacity-40"
          :disabled="closing.busy || !confirmClose"
        >
          {{ closing.busy ? 'One moment…' : 'Close account' }}
        </button>
      </form>
    </div>
  </section>
</template>
