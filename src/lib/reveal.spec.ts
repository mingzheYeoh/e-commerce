import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { defineComponent, h, withDirectives } from 'vue'
import { mount } from '@vue/test-utils'
import { vReveal } from './reveal'

/** An IntersectionObserver the test can fire by hand. */
let fire: ((isIntersecting: boolean) => void) | null = null
const disconnect = vi.fn()
class FakeObserver {
  constructor(cb: IntersectionObserverCallback) {
    fire = (isIntersecting) =>
      cb([{ isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
  }
  observe() {}
  disconnect = disconnect
}

const Grid = (count: number) =>
  defineComponent({
    render: () =>
      withDirectives(
        h('div', Array.from({ length: count }, (_, i) => h('p', `item ${i}`))),
        [[vReveal]],
      ),
  })

/** Where the element sits: below the fold unless told otherwise. */
function placeAt(top: number) {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ top } as DOMRect)
}

describe('vReveal', () => {
  beforeEach(() => {
    document.documentElement.dataset.motion = 'full'
    vi.stubGlobal('IntersectionObserver', FakeObserver)
    fire = null
    disconnect.mockClear()
    placeAt(window.innerHeight + 200)
  })
  afterEach(() => {
    delete document.documentElement.dataset.motion
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('holds a below-the-fold section back, then plays it in when it scrolls into view', () => {
    const el = mount(Grid(3)).element as HTMLElement
    expect(el.classList.contains('reveal-wait')).toBe(true)

    fire!(true)
    expect(el.classList.contains('reveal-wait')).toBe(false)
    expect(el.classList.contains('reveal-play')).toBe(true)
    expect(disconnect).toHaveBeenCalled()
  })

  it('staggers the children in order, capped so a long grid does not keep the last one waiting', () => {
    const el = mount(Grid(12)).element as HTMLElement
    const order = [...el.children].map((c) => (c as HTMLElement).style.getPropertyValue('--reveal-i'))
    expect(order.slice(0, 4)).toEqual(['0', '1', '2', '3'])
    expect(Math.max(...order.map(Number))).toBeLessThanOrEqual(7)
  })

  it('ignores the observer reporting it out of view', () => {
    const el = mount(Grid(2)).element as HTMLElement
    fire!(false)
    expect(el.classList.contains('reveal-wait')).toBe(true)
  })

  it('leaves the section alone when motion is reduced', () => {
    document.documentElement.dataset.motion = 'reduced'
    const el = mount(Grid(2)).element as HTMLElement
    expect(el.className).toBe('')
  })

  it('leaves the section alone without IntersectionObserver, so nothing is stuck hidden', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const el = mount(Grid(2)).element as HTMLElement
    expect(el.className).toBe('')
  })

  it('does not hide a section that is already on screen', () => {
    // Hiding it to fade it straight back in reads as a flicker, not an entrance.
    placeAt(100)
    const el = mount(Grid(2)).element as HTMLElement
    expect(el.className).toBe('')
  })

  it('stops observing when the section unmounts', () => {
    const w = mount(Grid(2))
    w.unmount()
    expect(disconnect).toHaveBeenCalled()
  })
})
