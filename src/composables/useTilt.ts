import { onUnmounted } from 'vue'

/**
 * Pointer-tracked 3D tilt and spotlight for a card.
 *
 * CSS `perspective` and two rotations, not a WebGL scene. A catalogue grid is
 * forty-five of these on screen at once; the version of this effect that ships
 * a renderer and a model costs megabytes to make a card lean six degrees.
 *
 * It writes CSS custom properties straight onto the element — `--rx`/`--ry`
 * for the rotation, `--gx`/`--gy` for where the light sits — and the
 * stylesheet (`.tilt`, `.spotlight` in main.css) turns them into a transform
 * and a gradient. Nothing reactive changes, so a pointer crossing a grid of
 * forty-five cards re-renders none of them.
 *
 * Three things it refuses to run for, all of them silent failures otherwise:
 *
 * - **Reduced motion.** Read from `<html data-motion>` at event time rather
 *   than through a per-card media query listener, because forty-five listeners
 *   for one preference is forty-five listeners. That attribute is written by
 *   useReducedMotion and already honours the `?motion=on` override, so the tilt
 *   follows the same switch as everything else.
 * - **Coarse pointers.** On a touchscreen `pointermove` arrives only while a
 *   finger is down, so the card would lurch on tap and stay tilted after it.
 * - **Pointers with no hover.** A stylus or a trackpad emulating touch reports
 *   fine coordinates it never sends between taps.
 */

/** Six degrees. Enough to read as depth, not enough to look like a gimmick. */
const MAX_DEG = 6

const PROPS = ['--rx', '--ry', '--gx', '--gy'] as const

export function useTilt(maxDeg = MAX_DEG) {
  // A ceiling, not a default: a caller asking for twenty still gets six.
  const deg = Math.min(Math.max(maxDeg, 0), MAX_DEG)
  let frame = 0
  let current: HTMLElement | null = null

  const enabled = () =>
    typeof window !== 'undefined' &&
    document.documentElement.dataset.motion !== 'reduced' &&
    window.matchMedia('(hover: hover) and (pointer: fine)').matches

  function onMove(event: PointerEvent) {
    if (!enabled()) return
    const el = event.currentTarget as HTMLElement | null
    if (!el) return

    const rect = el.getBoundingClientRect()
    // -0.5 at one edge, +0.5 at the other, and clamped there. A pointer can be
    // reported outside the element it is bound to — a fast drag off the grid
    // delivers a last move past the edge — and unclamped that is a card
    // snapping to fifteen degrees on its way out.
    const clamp = (n: number) => Math.min(0.5, Math.max(-0.5, n))
    const x = clamp((event.clientX - rect.left) / rect.width - 0.5)
    const y = clamp((event.clientY - rect.top) / rect.height - 0.5)

    // One update per frame. pointermove fires far faster than the screen
    // refreshes, and every extra write is a style recalc nobody sees.
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      current = el
      /*
       * Signs chosen so the corner under the pointer comes TOWARD the viewer,
       * which is what makes the sheen coherent: a highlight belongs on the
       * part of a surface turned to the light, not on the part turning away.
       *
       * CSS puts +Y downward, so a positive rotateX brings the bottom edge
       * forward and a positive rotateY brings the left edge forward — both the
       * opposite way round from the intuition. Written the obvious way, the
       * card leans away from the cursor while the highlight follows it.
       */
      el.style.setProperty('--rx', `${(y * deg).toFixed(2)}deg`)
      el.style.setProperty('--ry', `${(-x * deg).toFixed(2)}deg`)
      // Rounded: this goes straight into a CSS gradient, and floating point
      // otherwise writes `9.999999999999998%` into the DOM.
      const pct = (n: number) => `${Math.round((n + 0.5) * 1000) / 10}%`
      el.style.setProperty('--gx', pct(x))
      el.style.setProperty('--gy', pct(y))
    })
  }

  /**
   * Cleared rather than set to zero, so the CSS transition returns the card to
   * whatever the stylesheet says at rest. Takes the event when it has one; the
   * card also calls it bare, to stand the tilt down while a photo is dragged.
   */
  function onLeave(event?: Event) {
    cancelAnimationFrame(frame)
    const el = (event?.currentTarget as HTMLElement | null) ?? current
    if (el) for (const name of PROPS) el.style.removeProperty(name)
    current = null
  }

  onUnmounted(() => cancelAnimationFrame(frame))

  return { onMove, onLeave }
}
