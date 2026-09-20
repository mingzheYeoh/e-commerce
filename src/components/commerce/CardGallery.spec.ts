import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import CardGallery from './CardGallery.vue'

/**
 * The strip lives inside a RouterLink, so every one of these is really asking
 * the same question: did this gesture mean "look at the next photo" or "open
 * the product"? Getting it wrong either navigates mid-swipe or makes a card
 * that cannot be clicked.
 *
 * Driven with synthetic events rather than a real browser on purpose: a
 * headless drag below the threshold dispatches nothing at all, so the case that
 * matters most — a slightly unsteady click — is unobservable there.
 */
const IMAGES = ['/a-1.webp', '/a-2.webp', '/a-3.webp']

/** jsdom implements neither, and both are called on every drag. */
beforeEach(() => {
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
})

function gallery() {
  const wrapper = mount(CardGallery, { props: { images: IMAGES, alt: 'A thing' } })
  const el = wrapper.element as HTMLElement
  return { wrapper, el }
}

/**
 * jsdom has no PointerEvent, and MouseEvent exposes `button` as a getter, so
 * the pointer-specific fields have to be defined rather than assigned.
 */
function pointer(type: string, clientX: number): PointerEvent {
  const event = new MouseEvent(type, { clientX, button: 0, bubbles: true, cancelable: true })
  Object.defineProperty(event, 'isPrimary', { value: true })
  Object.defineProperty(event, 'pointerId', { value: 1 })
  return event as unknown as PointerEvent
}

/** One whole gesture: press, move, release. */
function drag(el: HTMLElement, from: number, to: number) {
  el.dispatchEvent(pointer('pointerdown', from))
  el.dispatchEvent(pointer('pointermove', to))
  el.dispatchEvent(pointer('pointerup', to))
}

/** What the RouterLink would see next. Returns true if the link would follow. */
function clickWouldNavigate(el: HTMLElement): boolean {
  const click = new MouseEvent('click', { bubbles: true, cancelable: true })
  el.dispatchEvent(click)
  return !click.defaultPrevented
}

const activeIndex = (wrapper: ReturnType<typeof gallery>['wrapper']) =>
  wrapper.findAll('button[aria-label^="Photo"]').findIndex((b) => b.attributes('aria-current'))

describe('CardGallery gestures', () => {
  it('a drag past the threshold moves one photo and does not open the product', async () => {
    const { wrapper, el } = gallery()
    ;(wrapper.vm as unknown as { slides: string[] }).slides = IMAGES
    await wrapper.vm.$nextTick()

    drag(el, 300, 200) // 100px left
    await wrapper.vm.$nextTick()

    expect(activeIndex(wrapper)).toBe(1)
    expect(clickWouldNavigate(el), 'a swipe must not follow the link').toBe(false)
  })

  it('a small wobble is a click, not a swipe', async () => {
    // The case a headless drag cannot produce. Without this, an unsteady hand
    // makes a card that silently refuses to open.
    const { wrapper, el } = gallery()
    ;(wrapper.vm as unknown as { slides: string[] }).slides = IMAGES
    await wrapper.vm.$nextTick()

    drag(el, 300, 285) // 15px, under the 40px threshold
    await wrapper.vm.$nextTick()

    expect(activeIndex(wrapper), 'the photo must not change').toBe(0)
    expect(clickWouldNavigate(el), 'a wobble must still open the product').toBe(true)
  })

  it('only swallows the one click that belongs to the swipe', async () => {
    const { wrapper, el } = gallery()
    ;(wrapper.vm as unknown as { slides: string[] }).slides = IMAGES
    await wrapper.vm.$nextTick()

    drag(el, 300, 200)
    await wrapper.vm.$nextTick()
    expect(clickWouldNavigate(el)).toBe(false)
    // The next one is an ordinary click again.
    expect(clickWouldNavigate(el), 'suppression must not be sticky').toBe(true)
  })

  it('does not eat the next tap when the swipe produced no click', async () => {
    /*
     * The bug this file missed the first time, found on staging. A touch drag
     * frequently produces no click at all, and a suppressor armed for one that
     * never arrives stays armed — so the user's next tap vanishes and the card
     * looks like it ignored them until they tried twice.
     *
     * The distinguishing move is the absence below: no click after the drag.
     */
    vi.useFakeTimers()
    const { wrapper, el } = gallery()
    ;(wrapper.vm as unknown as { slides: string[] }).slides = IMAGES
    await wrapper.vm.$nextTick()

    drag(el, 300, 200)
    await wrapper.vm.$nextTick()

    vi.advanceTimersByTime(200)
    expect(clickWouldNavigate(el), 'a later tap must open the product').toBe(true)
    vi.useRealTimers()
  })

  it('stops at the ends instead of running off', async () => {
    const { wrapper, el } = gallery()
    ;(wrapper.vm as unknown as { slides: string[] }).slides = IMAGES
    await wrapper.vm.$nextTick()

    for (let i = 0; i < 5; i++) {
      drag(el, 300, 200)
      await wrapper.vm.$nextTick()
    }
    expect(activeIndex(wrapper)).toBe(IMAGES.length - 1)

    for (let i = 0; i < 5; i++) {
      drag(el, 200, 300)
      await wrapper.vm.$nextTick()
    }
    expect(activeIndex(wrapper)).toBe(0)
  })

  it('tells the card when a drag starts and stops, so the tilt stands down', async () => {
    // Two transforms answering one pointer is not depth, it is a wobble.
    const { wrapper, el } = gallery()
    drag(el, 300, 200)
    expect(wrapper.emitted('dragging')?.map(([v]) => v)).toEqual([true, false])
  })

  it('shows one photo and no dots until the rest are known to load', () => {
    // The hero is guaranteed; the tail is not, and a missing file serves the
    // SPA shell rather than 404ing. Dots for photos that do not exist would be
    // a promise the card cannot keep.
    const { wrapper } = gallery()
    expect(wrapper.findAll('img')).toHaveLength(1)
    expect(wrapper.findAll('button[aria-label^="Photo"]')).toHaveLength(0)
  })

  it('a dot jumps to its photo without opening the product', async () => {
    const { wrapper, el } = gallery()
    ;(wrapper.vm as unknown as { slides: string[] }).slides = IMAGES
    await wrapper.vm.$nextTick()

    await wrapper.findAll('button[aria-label^="Photo"]')[2].trigger('click')
    expect(activeIndex(wrapper)).toBe(2)
    expect(clickWouldNavigate(el)).toBe(true)
  })
})
