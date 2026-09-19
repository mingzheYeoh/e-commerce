import { ref, watchEffect, onUnmounted, type Ref } from 'vue'

const QUERY = '(prefers-reduced-motion: reduce)'

/**
 * `?motion=on` forces animation, `?motion=off` forces the static page.
 *
 * Without this escape hatch anyone whose OS has "reduce motion" enabled — which
 * is a lot of people, and easy to leave on by accident — can never see the
 * motion design at all, not even to check it. The OS preference still wins by
 * default; this only exists to override it deliberately.
 */
function override(): boolean | null {
  if (typeof window === 'undefined') return null
  const value = new URLSearchParams(window.location.search).get('motion')
  if (value === 'on') return false
  if (value === 'off') return true
  return null
}

function systemPrefersReduced(): boolean {
  return typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia(QUERY).matches
    : false
}

/** Non-reactive one-shot read, for setup-time branching (Lenis, ScrollTrigger). */
export function prefersReducedMotion(): boolean {
  return override() ?? systemPrefersReduced()
}

/**
 * Reactive flag, and the single writer of `<html data-motion>`. Every motion
 * kill-switch in the CSS hangs off that attribute rather than the media query
 * directly, so the override applies to CSS animations too — not just the
 * JS-driven ones.
 */
export function useReducedMotion(): Ref<boolean> {
  const reduced = ref(prefersReducedMotion())

  if (typeof window !== 'undefined' && window.matchMedia) {
    const mql = window.matchMedia(QUERY)

    const onChange = (event: MediaQueryListEvent) => {
      reduced.value = override() ?? event.matches
    }
    mql.addEventListener('change', onChange)
    onUnmounted(() => mql.removeEventListener('change', onChange))
  }

  watchEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.dataset.motion = reduced.value ? 'reduced' : 'full'
    }
  })

  return reduced
}
