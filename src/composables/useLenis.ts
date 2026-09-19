import { onMounted, onUnmounted } from 'vue'
import Lenis from 'lenis'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { prefersReducedMotion } from './useReducedMotion'

/**
 * Inertial scrolling, driven from GSAP's ticker rather than its own rAF loop.
 *
 * Two independent rAF loops is the classic cause of scrub jitter: Lenis moves
 * the page on frame N while ScrollTrigger samples position from frame N-1. One
 * ticker means one clock for both.
 *
 * Call once, from the app root.
 */
export function useLenis() {
  let lenis: Lenis | null = null
  let tick: ((time: number) => void) | null = null

  onMounted(() => {
    // Reduced motion: native scroll only. Lenis is never constructed, so it
    // cannot hijack the wheel or fight assistive tech.
    if (prefersReducedMotion()) {
      ScrollTrigger.refresh()
      return
    }

    lenis = new Lenis({
      duration: 1.1,
      easing: (t: number) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      smoothWheel: true,
      touchMultiplier: 1.6,
    })

    lenis.on('scroll', ScrollTrigger.update)

    // gsap.ticker time is seconds; Lenis wants milliseconds.
    tick = (time: number) => lenis?.raf(time * 1000)
    gsap.ticker.add(tick)
    gsap.ticker.lagSmoothing(0)

    ScrollTrigger.refresh()
  })

  onUnmounted(() => {
    if (tick) gsap.ticker.remove(tick)
    lenis?.destroy()
    lenis = null
    tick = null
  })
}
