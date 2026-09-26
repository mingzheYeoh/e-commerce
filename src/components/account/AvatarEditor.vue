<script setup lang="ts">
/**
 * The account's photo: shown here and in the header. Resized to 256px webp in
 * the browser; the server replaces the old one and deletes it from storage.
 */
import { ref } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { uploadAvatar, removeAvatar } from '@/lib/uploads'

const auth = useAuthStore()
const busy = ref(false)
const error = ref('')

function show(avatarUrl: string | null) {
  if (auth.user) auth.user = { ...auth.user, avatarUrl }
}

async function pick(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  busy.value = true
  error.value = ''
  const res = await uploadAvatar(file)
  busy.value = false
  if (res.ok) show(res.data.avatarUrl)
  else error.value = res.error
}

async function clear() {
  busy.value = true
  error.value = ''
  const res = await removeAvatar()
  busy.value = false
  if (res.ok) show(null)
  else error.value = res.error
}
</script>

<template>
  <div class="flex items-center gap-4">
    <img
      v-if="auth.user?.avatarUrl"
      :src="auth.user.avatarUrl"
      alt="Your photo"
      class="h-16 w-16 rounded-full border border-border-hairline object-cover"
    />
    <span
      v-else
      class="flex h-16 w-16 items-center justify-center rounded-full border border-border-hairline bg-surface-2 text-xl font-semibold text-text-secondary"
      aria-hidden="true"
    >{{ auth.firstName.slice(0, 1).toUpperCase() }}</span>
    <div class="flex flex-col items-start gap-1">
      <label class="btn-ghost cursor-pointer px-3 py-1.5 text-xs" :class="busy ? 'pointer-events-none opacity-60' : ''">
        {{ auth.user?.avatarUrl ? 'Change photo' : 'Add a photo' }}
        <input type="file" accept="image/*" class="sr-only" :disabled="busy" @change="pick" />
      </label>
      <button
        v-if="auth.user?.avatarUrl"
        type="button"
        class="text-xs text-text-muted hover:text-text-primary"
        :disabled="busy"
        @click="clear"
      >Remove</button>
      <p v-if="error" class="text-xs text-accent-red" role="alert">{{ error }}</p>
    </div>
  </div>
</template>
