import { describe, it, expect } from 'vitest'
import { splitRows, marqueeTrack } from './marquee'

describe('splitRows', () => {
  it('deals items alternately so both rows get a mix and none is lost', () => {
    const [a, b] = splitRows(['A', 'B', 'C', 'D', 'E'])
    expect(a).toEqual(['A', 'C', 'E'])
    expect(b).toEqual(['B', 'D'])
  })
})

describe('marqueeTrack', () => {
  const ids = (track: { item: string }[]) => track.map((t) => t.item)

  it('is two identical halves, so sliding exactly -50% loops without a seam', () => {
    const track = marqueeTrack(['A', 'B', 'C'], 7)
    const half = track.length / 2
    expect(Number.isInteger(half)).toBe(true)
    expect(ids(track.slice(0, half))).toEqual(ids(track.slice(half)))
  })

  it('repeats a short row until one half is at least the minimum long', () => {
    // Ten brands at ~180px is narrower than a wide monitor; without the
    // repeats the loop shows a gap before the second half arrives.
    const track = marqueeTrack(['A', 'B', 'C'], 7)
    expect(track.length / 2).toBeGreaterThanOrEqual(7)
    expect(ids(track.slice(0, 3))).toEqual(['A', 'B', 'C'])
  })

  it('exposes each item exactly once and marks every repeat as a copy', () => {
    // Copies are aria-hidden and out of the tab order: a screen reader should
    // hear each brand once, and Tab should not walk the same list four times.
    const track = marqueeTrack(['A', 'B', 'C'], 7)
    const real = track.filter((t) => !t.copy)
    expect(ids(real)).toEqual(['A', 'B', 'C'])
    expect(track.slice(0, 3).every((t) => !t.copy)).toBe(true)
    expect(track.slice(3).every((t) => t.copy)).toBe(true)
  })

  it('gives every entry a distinct key', () => {
    const track = marqueeTrack(['A', 'B'], 5)
    expect(new Set(track.map((t) => t.key)).size).toBe(track.length)
  })

  it('returns nothing for an empty row', () => {
    expect(marqueeTrack([], 10)).toEqual([])
  })
})
