/**
 * Whether to hold still.
 *
 * `<html data-motion>` decides when something has set it: the storefront's
 * useReducedMotion writes it (and honours ?motion=on), and the console's
 * main.ts writes it from the system setting. Otherwise the system setting is
 * read directly. Either way the shared CSS kill switch and the JS that drives
 * the rolling figures agree.
 */
export const REDUCE_QUERY = '(prefers-reduced-motion: reduce)'

export function motionReduced(): boolean {
  if (typeof document === 'undefined') return false
  const set = document.documentElement.dataset.motion
  if (set) return set === 'reduced'
  return typeof window.matchMedia === 'function' && window.matchMedia(REDUCE_QUERY).matches
}
