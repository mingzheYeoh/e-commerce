/** Deals items alternately into two rows, so neither row is "the A–K brands". */
export function splitRows<T>(items: readonly T[]): [T[], T[]] {
  return [items.filter((_, i) => i % 2 === 0), items.filter((_, i) => i % 2 === 1)]
}

export interface TrackEntry<T> {
  item: T
  /** A repeat for the loop: aria-hidden and out of the tab order. */
  copy: boolean
  key: number
}

/**
 * One marquee row: the items once for real, then repeats.
 *
 * The track is two identical halves and the animation slides exactly -50%, so
 * the seam lands on an identical frame. Each half repeats the row until it is
 * at least `minItems` long — a half narrower than the viewport shows a gap
 * before the loop comes round.
 */
export function marqueeTrack<T>(row: readonly T[], minItems: number): TrackEntry<T>[] {
  if (!row.length) return []
  const perHalf = row.length * Math.max(1, Math.ceil(minItems / row.length))
  return Array.from({ length: perHalf * 2 }, (_, i) => ({
    item: row[i % row.length],
    copy: i >= row.length,
    key: i,
  }))
}
