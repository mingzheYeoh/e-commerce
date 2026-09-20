import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useTilt } from './useTilt'

/**
 * jsdom reports `matches: false` for every query, which would disable the tilt
 * and make each of these pass for the wrong reason.
 */
function stubPointer({ fine }: { fine: boolean }) {
  window.matchMedia = ((query: string) =>
    ({
      matches: query.includes('hover: hover') ? fine : false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }) as unknown as MediaQueryList) as typeof window.matchMedia
}

/** A 200x100 card whose top-left corner is at the viewport origin. */
function card() {
  const el = document.createElement('a')
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100 }) as DOMRect
  return el
}

const move = (el: HTMLElement, clientX: number, clientY: number) =>
  ({ currentTarget: el, clientX, clientY }) as unknown as PointerEvent

/** The tilt is written inside requestAnimationFrame. */
const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)))

const degrees = (transform: string) => ({
  rx: Number(transform.match(/rotateX\((-?[\d.]+)deg\)/)?.[1]),
  ry: Number(transform.match(/rotateY\((-?[\d.]+)deg\)/)?.[1]),
})

describe('useTilt', () => {
  beforeEach(() => {
    stubPointer({ fine: true })
    document.documentElement.dataset.motion = 'full'
  })
  afterEach(() => {
    delete document.documentElement.dataset.motion
  })

  it('lifts the corner under the pointer toward the viewer', async () => {
    /*
     * The rule the whole effect rests on, and the one that was wrong first
     * time. CSS puts +Y downward, so a positive rotateX brings the BOTTOM
     * forward and a positive rotateY brings the LEFT forward — both the
     * opposite way round from the intuition. Written the obvious way the card
     * leans away from the cursor while the highlight follows it, which reads as
     * a lighting bug rather than a direction choice.
     */
    const tilt = useTilt(6)
    const el = card()

    tilt.onMove(move(el, 10, 10)) // top-left
    await frame()
    const topLeft = degrees(tilt.transform.value!)
    expect(topLeft.rx, 'top pointer must pull the top forward: negative rotateX').toBeLessThan(0)
    expect(topLeft.ry, 'left pointer must pull the left forward: positive rotateY').toBeGreaterThan(0)

    tilt.onMove(move(el, 190, 90)) // bottom-right
    await frame()
    const bottomRight = degrees(tilt.transform.value!)
    expect(bottomRight.rx).toBeGreaterThan(0)
    expect(bottomRight.ry).toBeLessThan(0)
  })

  it('is flat at the centre and symmetric about it', async () => {
    const tilt = useTilt(6)
    const el = card()

    tilt.onMove(move(el, 100, 50))
    await frame()
    expect(Math.abs(degrees(tilt.transform.value!).rx)).toBe(0)

    tilt.onMove(move(el, 0, 50))
    await frame()
    const left = degrees(tilt.transform.value!).ry
    tilt.onMove(move(el, 200, 50))
    await frame()
    expect(degrees(tilt.transform.value!).ry).toBe(-left)
  })

  it('never exceeds the angle it was given', async () => {
    // Called with coordinates outside the card, which pointermove does deliver
    // during a fast drag across the grid.
    const tilt = useTilt(6)
    const el = card()
    tilt.onMove(move(el, -400, -400))
    await frame()
    const { rx, ry } = degrees(tilt.transform.value!)
    expect(Math.abs(rx)).toBeLessThanOrEqual(6)
    expect(Math.abs(ry)).toBeLessThanOrEqual(6)
  })

  it('does nothing at all when motion is reduced', async () => {
    // Not "animates less" — produces no transform, so the card stays flat.
    document.documentElement.dataset.motion = 'reduced'
    const tilt = useTilt()
    tilt.onMove(move(card(), 10, 10))
    await frame()
    expect(tilt.transform.value).toBe('')
    expect(tilt.glare.value).toBeNull()
  })

  it('does nothing on a touchscreen', async () => {
    // pointermove only arrives while a finger is down, so a card would lurch on
    // tap and stay tilted after it.
    stubPointer({ fine: false })
    const tilt = useTilt()
    tilt.onMove(move(card(), 10, 10))
    await frame()
    expect(tilt.transform.value).toBe('')
  })

  it('returns to rest by clearing the style, not by zeroing it', async () => {
    // An explicit rotate(0) would fight the stylesheet for what "at rest"
    // means; an empty string lets the CSS transition take the card home.
    const tilt = useTilt()
    const el = card()
    tilt.onMove(move(el, 10, 10))
    await frame()
    expect(tilt.transform.value).not.toBe('')

    tilt.onLeave()
    expect(tilt.transform.value).toBe('')
    expect(tilt.glare.value).toBeNull()
  })

  it('reports the pointer position for the sheen as percentages', async () => {
    const tilt = useTilt()
    tilt.onMove(move(card(), 50, 25))
    await frame()
    expect(tilt.glare.value).toEqual({ x: 25, y: 25 })
  })

  it('coalesces a burst of moves into the last one', async () => {
    // pointermove fires far faster than the screen refreshes. Every event that
    // is not the latest is a style write nobody ever sees.
    const drop = vi.spyOn(window, 'cancelAnimationFrame')
    const tilt = useTilt(6)
    const el = card()
    for (let i = 0; i < 5; i++) tilt.onMove(move(el, 20 * i, 10))
    await frame()

    // The last move was at x = 80 of 200, so 15% left of centre.
    expect(tilt.glare.value).toEqual({ x: 40, y: 10 })
    expect(drop, 'every move must cancel the frame before it').toHaveBeenCalledTimes(5)
    drop.mockRestore()
  })
})
