import type { Directive } from 'vue'

/**
 * `v-reveal`: a section's children rise into place, one after another, the
 * first time it scrolls into view.
 *
 * Visible is the default. The directive only hides anything once it knows it
 * can bring it back — motion allowed, IntersectionObserver present, section
 * still below the fold — so a script that fails to load, or a browser without
 * the API, gets a complete page rather than blank sections.
 *
 * The entrance is a CSS animation on `translate` (main.css, `.reveal-*`), not
 * a transition on `transform`: the product cards own `transform` for their
 * tilt and `transition` for its easing, and a reveal that touched either would
 * fight them.
 */

/** Past this the last tile waits long enough to look broken rather than staggered. */
const MAX_STEP = 7

const observers = new WeakMap<HTMLElement, IntersectionObserver>()

export const vReveal: Directive<HTMLElement> = {
  mounted(el) {
    if (document.documentElement.dataset.motion === 'reduced') return
    if (typeof IntersectionObserver === 'undefined') return
    if (el.getBoundingClientRect().top < window.innerHeight) return

    ;[...el.children].forEach((child, i) =>
      (child as HTMLElement).style.setProperty('--reveal-i', String(Math.min(i, MAX_STEP))),
    )
    el.classList.add('reveal-wait')

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return
        el.classList.replace('reveal-wait', 'reveal-play')
        observer.disconnect()
      },
      { rootMargin: '0px 0px -10% 0px' },
    )
    observer.observe(el)
    observers.set(el, observer)
  },
  unmounted(el) {
    observers.get(el)?.disconnect()
  },
}
