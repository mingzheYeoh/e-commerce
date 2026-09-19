import { watch, nextTick, type Ref } from 'vue'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Keeps keyboard focus inside an overlay while it is open, and hands focus back
 * to whatever opened it on close.
 *
 * Without this a screen-reader or keyboard user tabs straight out of an open
 * drawer into the page behind it, which is still there and still scrollable —
 * so they are reading one thing and interacting with another.
 *
 * Used by the cart drawer and the search palette.
 */
export function useFocusTrap(panel: Ref<HTMLElement | null>, isOpen: Ref<boolean>, close: () => void) {
  let lastFocused: HTMLElement | null = null

  const focusables = () =>
    panel.value ? Array.from(panel.value.querySelectorAll<HTMLElement>(FOCUSABLE)) : []

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    if (event.key !== 'Tab') return

    const items = focusables()
    if (!items.length) return

    const first = items[0]
    const last = items[items.length - 1]
    const active = document.activeElement

    if (event.shiftKey && active === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }

  watch(isOpen, async (open) => {
    if (open) {
      lastFocused = document.activeElement as HTMLElement | null
      document.body.style.overflow = 'hidden'
      document.addEventListener('keydown', onKeydown)
      await nextTick()
      focusables()[0]?.focus()
    } else {
      document.body.style.overflow = ''
      document.removeEventListener('keydown', onKeydown)
      lastFocused?.focus()
      lastFocused = null
    }
  })
}
