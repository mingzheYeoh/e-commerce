<script setup lang="ts">
/**
 * Shown instead of adding to the bag when nobody is signed in (see cart.add).
 *
 * The product waits in the ui store while the shopper signs in, and goes into
 * the bag the moment they do: a sign-in that forgot what they came for would
 * be a second chore. Dismissing the prompt forgets it.
 *
 * A native <dialog> for the modal behaviour: focus is trapped and Escape
 * closes it without any code here.
 */
import { ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { X } from 'lucide-vue-next'
import { useUiStore } from '@/stores/ui'
import { useAuthStore } from '@/stores/auth'
import { useCartStore } from '@/stores/cart'

const ui = useUiStore()
const auth = useAuthStore()
const cart = useCartStore()
const route = useRoute()
const router = useRouter()

const dialog = ref<HTMLDialogElement | null>(null)
/** Closing to go and sign in, as opposed to dismissing. */
let leaving = false

watch(
  () => ui.signInFor,
  (want) => {
    if (want && !dialog.value?.open) dialog.value?.showModal()
  },
)

watch(
  () => auth.signedIn,
  (signedIn) => {
    const want = ui.signInFor
    if (!signedIn || !want) return
    ui.signInFor = null
    cart.add(want.product, want.qty, want.finish)
  },
)

function go(mode?: 'up') {
  leaving = true
  dialog.value?.close()
  void router.push({ path: '/account', query: { next: route.fullPath, ...(mode && { mode }) } })
}

function closed() {
  if (!leaving) ui.signInFor = null
  leaving = false
}
</script>

<template>
  <dialog
    ref="dialog"
    data-lenis-prevent
    aria-labelledby="signin-prompt-heading"
    class="w-[calc(100%-2rem)] max-w-sm rounded-card border border-border-hairline bg-surface-1 p-0 text-text-primary backdrop:bg-black/60 backdrop:backdrop-blur-sm"
    @close="closed"
    @click.self="dialog?.close()"
  >
    <!-- The padding lives here, so a click on the dialog itself is a click on the backdrop. -->
    <div class="relative p-6">
      <button
        type="button"
        class="absolute right-3 top-3 rounded p-1 text-text-secondary hover:text-text-primary"
        aria-label="Close"
        @click="dialog?.close()"
      >
        <X class="h-4 w-4" aria-hidden="true" />
      </button>

      <h2 id="signin-prompt-heading" class="pr-6 text-lg font-bold">Sign in to add to your bag</h2>
      <p class="mt-2 text-sm text-text-secondary">
        <template v-if="ui.signInFor">{{ ui.signInFor.product.title }} will be waiting in your bag once you do.</template>
        Orders are kept with your account, so you can track them from any device.
      </p>

      <div class="mt-6 flex flex-col gap-2">
        <button type="button" class="btn-primary justify-center" @click="go()">Sign in</button>
        <button type="button" class="btn-ghost justify-center" @click="go('up')">Create an account</button>
      </div>
    </div>
  </dialog>
</template>
