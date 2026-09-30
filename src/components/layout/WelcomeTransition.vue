<script setup lang="ts">
/**
 * The moment between signing in and the page they came for.
 *
 * A brand gradient opens out from the middle of the screen with a greeting,
 * the route changes underneath it while it covers everything, and then it
 * lifts to show where they landed. Changing the route under cover means the
 * account form never visibly jumps to the home page, and the home page's first
 * paint (the heaviest on the site) happens out of sight.
 *
 * Under reduced motion the kill switch in main.css collapses the transitions,
 * and the hold below is skipped, so it is an ordinary navigation.
 */
import { watch } from 'vue'
import { useRouter } from 'vue-router'
import { useUiStore } from '@/stores/ui'
import { prefersReducedMotion } from '@/composables/useReducedMotion'

/** Long enough for the gradient to open and the greeting to be read. */
const HOLD_MS = 1200

const ui = useUiStore()
const router = useRouter()

watch(
  () => ui.welcome,
  async (welcome) => {
    if (!welcome) return
    await new Promise((resolve) => setTimeout(resolve, prefersReducedMotion() ? 0 : HOLD_MS))
    await router.replace(welcome.to)
    // Clearing it is what plays the leave transition.
    ui.welcome = null
  },
)
</script>

<template>
  <Transition name="welcome">
    <div
      v-if="ui.welcome"
      class="welcome fixed inset-0 z-[90] flex items-center justify-center"
      role="status"
      aria-live="polite"
    >
      <p class="welcome-text px-6 text-center font-display text-3xl font-bold text-white md:text-5xl">
        {{ ui.welcome.message }}
      </p>
    </div>
  </Transition>
</template>

<style scoped>
.welcome {
  /* The accent, walked through its iOS neighbours, over the page's own black. */
  background:
    radial-gradient(60% 60% at 30% 35%, rgba(10, 132, 255, 0.95), transparent 70%),
    radial-gradient(55% 55% at 72% 68%, rgba(94, 92, 230, 0.9), transparent 70%),
    radial-gradient(45% 45% at 55% 20%, rgba(100, 210, 255, 0.55), transparent 70%),
    #0b0b0d;
  background-size: 140% 140%;
  animation: welcome-drift 2.4s ease-in-out infinite alternate;
}

@keyframes welcome-drift {
  from {
    background-position: 0% 0%;
  }
  to {
    background-position: 100% 100%;
  }
}

/* In: opens out from the centre. Out: lifts away. */
.welcome-enter-active {
  transition: clip-path 0.7s cubic-bezier(0.65, 0, 0.35, 1);
}
.welcome-enter-from {
  clip-path: circle(0% at 50% 50%);
}
.welcome-enter-to {
  clip-path: circle(75% at 50% 50%);
}
.welcome-leave-active {
  transition: opacity 0.5s ease;
}
.welcome-leave-to {
  opacity: 0;
}

.welcome-enter-active .welcome-text {
  transition:
    opacity 0.5s ease 0.35s,
    transform 0.5s ease 0.35s;
}
.welcome-enter-from .welcome-text {
  opacity: 0;
  transform: translateY(12px);
}
</style>
