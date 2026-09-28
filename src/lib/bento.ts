/**
 * Tile sizes for the category bento, derived from how many tiles there are
 * rather than written into the data. The data used to carry a `span` per
 * category, which meant a sixth department opened a hole in the grid until
 * someone re-drew it by hand.
 *
 * The grid is four columns wide. The first category is the hero: two columns
 * by two rows. The two-by-two block beside it takes up to four more, and
 * anything after that fills whole rows of four.
 */
export interface BentoTile {
  cols: 1 | 2 | 4
  rows: 1 | 2
}

/** Up to four tiles filling exactly `cells` columns of one row. */
const ROW: Record<number, BentoTile[]> = {
  1: [{ cols: 4, rows: 1 }],
  2: [{ cols: 2, rows: 1 }, { cols: 2, rows: 1 }],
  3: [{ cols: 2, rows: 1 }, { cols: 1, rows: 1 }, { cols: 1, rows: 1 }],
  4: [{ cols: 1, rows: 1 }, { cols: 1, rows: 1 }, { cols: 1, rows: 1 }, { cols: 1, rows: 1 }],
}

/** Fills the 2×2 block beside the hero with one to four tiles. */
const BESIDE: Record<number, BentoTile[]> = {
  1: [{ cols: 2, rows: 2 }],
  2: [{ cols: 2, rows: 1 }, { cols: 2, rows: 1 }],
  3: [{ cols: 2, rows: 1 }, { cols: 1, rows: 1 }, { cols: 1, rows: 1 }],
  4: [{ cols: 1, rows: 1 }, { cols: 1, rows: 1 }, { cols: 1, rows: 1 }, { cols: 1, rows: 1 }],
}

export function bentoLayout(count: number): BentoTile[] {
  if (count <= 0) return []
  if (count === 1) return [{ cols: 4, rows: 2 }]

  const tiles: BentoTile[] = [{ cols: 2, rows: 2 }]
  const beside = Math.min(count - 1, 4)
  tiles.push(...BESIDE[beside])

  for (let left = count - 1 - beside; left > 0; left -= 4) tiles.push(...ROW[Math.min(left, 4)])
  return tiles
}
