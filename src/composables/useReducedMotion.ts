import { ref, onUnmounted, type Ref } from 'vue'

const QUERY = '(prefers-reduced-motion: reduce)'

/**
 * Single source of truth for whether the site should animate. Reactive, so a
 * visitor toggling the OS setting mid-session gets the static page immediately.
 */
export function useReducedMotion(): Ref<boolean> {
  const reduced = ref(false)

  if (typeof window !== 'undefined' && window.matchMedia) {
    const mql = window.matchMedia(QUERY)
    reduced.value = mql.matches

    const onChange = (event: MediaQueryListEvent) => {
      reduced.value = event.matches
    }
    mql.addEventListener('change', onChange)
    onUnmounted(() => mql.removeEventListener('change', onChange))
  }

  return reduced
}

/** Non-reactive one-shot read, for setup-time branching. */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia(QUERY).matches
    : false
}
