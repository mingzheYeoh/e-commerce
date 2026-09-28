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

/**
 * The tilt is written as CSS custom properties on the element, not as reactive
 * state: forty-five cards re-rendering through Vue on every pointer frame is
 * the cost this design exists to avoid.
 */
const read = (el: HTMLElement, name: string) => el.style.getPropertyValue(name)
const degrees = (el: HTMLElement) => ({
  rx: parseFloat(read(el, '--rx')),
  ry: parseFloat(read(el, '--ry')),
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
    const topLeft = degrees(el)
    expect(topLeft.rx, 'top pointer must pull the top forward: negative rotateX').toBeLessThan(0)
    expect(topLeft.ry, 'left pointer must pull the left forward: positive rotateY').toBeGreaterThan(0)

    tilt.onMove(move(el, 190, 90)) // bottom-right
    await frame()
    const bottomRight = degrees(el)
    expect(bottomRight.rx).toBeGreaterThan(0)
    expect(bottomRight.ry).toBeLessThan(0)
  })

  it('writes angles with a unit, so the stylesheet can use them as-is', async () => {
    const tilt = useTilt(6)
    const el = card()
    tilt.onMove(move(el, 10, 10))
    await frame()
    expect(read(el, '--rx')).toMatch(/^-?\d+(\.\d+)?deg$/)
    expect(read(el, '--ry')).toMatch(/^-?\d+(\.\d+)?deg$/)
  })

  it('is flat at the centre and symmetric about it', async () => {
    const tilt = useTilt(6)
    const el = card()

    tilt.onMove(move(el, 100, 50))
    await frame()
    expect(Math.abs(degrees(el).rx)).toBe(0)

    tilt.onMove(move(el, 0, 50))
    await frame()
    const left = degrees(el).ry
    tilt.onMove(move(el, 200, 50))
    await frame()
    expect(degrees(el).ry).toBe(-left)
  })

  it('never exceeds the angle it was given', async () => {
    // Called with coordinates outside the card, which pointermove does deliver
    // during a fast drag across the grid.
    const tilt = useTilt(6)
    const el = card()
    tilt.onMove(move(el, -400, -400))
    await frame()
    const { rx, ry } = degrees(el)
    expect(Math.abs(rx)).toBeLessThanOrEqual(6)
    expect(Math.abs(ry)).toBeLessThanOrEqual(6)
  })

  it('refuses an angle past six degrees even when asked for one', async () => {
    // Six is the design's ceiling, not a default. A caller passing 20 gets a
    // gimmick, and nothing downstream would catch it.
    const tilt = useTilt(20)
    const el = card()
    tilt.onMove(move(el, 0, 0))
    await frame()
    const { rx, ry } = degrees(el)
    expect(Math.abs(rx)).toBeLessThanOrEqual(6)
    expect(Math.abs(ry)).toBeLessThanOrEqual(6)
  })

  it('does nothing at all when motion is reduced', async () => {
    // Not "animates less" — writes nothing, so the card stays flat.
    document.documentElement.dataset.motion = 'reduced'
    const tilt = useTilt()
    const el = card()
    tilt.onMove(move(el, 10, 10))
    await frame()
    expect(el.getAttribute('style') ?? '').toBe('')
  })

  it('does nothing on a touchscreen', async () => {
    // pointermove only arrives while a finger is down, so a card would lurch on
    // tap and stay tilted after it.
    stubPointer({ fine: false })
    const tilt = useTilt()
    const el = card()
    tilt.onMove(move(el, 10, 10))
    await frame()
    expect(el.getAttribute('style') ?? '').toBe('')
  })

  it('returns to rest by clearing the properties, not by zeroing them', async () => {
    // An explicit 0deg would fight the stylesheet for what "at rest" means;
    // removing the property lets the CSS transition take the card home.
    const tilt = useTilt()
    const el = card()
    tilt.onMove(move(el, 10, 10))
    await frame()
    expect(read(el, '--rx')).not.toBe('')

    tilt.onLeave()
    for (const name of ['--rx', '--ry', '--gx', '--gy']) expect(read(el, name)).toBe('')
  })

  it('reports the pointer position for the sheen as percentages', async () => {
    const tilt = useTilt()
    const el = card()
    tilt.onMove(move(el, 50, 25))
    await frame()
    expect(read(el, '--gx')).toBe('25%')
    expect(read(el, '--gy')).toBe('25%')
  })

  it('tracks the light without tilting when given zero degrees', async () => {
    // The category tiles want the spotlight and not the lean.
    const tilt = useTilt(0)
    const el = card()
    tilt.onMove(move(el, 150, 75))
    await frame()
    expect(read(el, '--gx')).toBe('75%')
    expect(Math.abs(degrees(el).rx)).toBe(0)
    expect(Math.abs(degrees(el).ry)).toBe(0)
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
    expect(read(el, '--gx')).toBe('40%')
    expect(read(el, '--gy')).toBe('10%')
    expect(drop, 'every move must cancel the frame before it').toHaveBeenCalledTimes(5)
    drop.mockRestore()
  })
})
