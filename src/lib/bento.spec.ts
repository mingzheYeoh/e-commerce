import { describe, it, expect } from 'vitest'
import { bentoLayout, type BentoTile } from './bento'

/**
 * Places tiles the way `grid-auto-flow: row dense` does on a four-column grid
 * and returns the occupancy, so a test can ask the question the eye asks:
 * is there a hole?
 */
function pack(tiles: BentoTile[], cols = 4) {
  const grid: boolean[][] = []
  const free = (r: number, c: number, t: BentoTile) => {
    if (c + t.cols > cols) return false
    for (let dr = 0; dr < t.rows; dr++)
      for (let dc = 0; dc < t.cols; dc++) if (grid[r + dr]?.[c + dc]) return false
    return true
  }
  for (const t of tiles) {
    placing: for (let r = 0; ; r++) {
      for (let c = 0; c < cols; c++) {
        if (!free(r, c, t)) continue
        for (let dr = 0; dr < t.rows; dr++) {
          grid[r + dr] ??= Array(cols).fill(false)
          for (let dc = 0; dc < t.cols; dc++) grid[r + dr][c + dc] = true
        }
        break placing
      }
    }
  }
  return grid
}

describe('bentoLayout', () => {
  it('leads with one large tile and keeps the rest smaller', () => {
    const tiles = bentoLayout(5)
    expect(tiles[0]).toEqual({ cols: 2, rows: 2 })
    for (const t of tiles.slice(1)) expect(t.cols * t.rows).toBeLessThan(4)
  })

  it('lays out today’s five departments as one hero and four around it', () => {
    expect(bentoLayout(5)).toEqual([
      { cols: 2, rows: 2 },
      { cols: 1, rows: 1 },
      { cols: 1, rows: 1 },
      { cols: 1, rows: 1 },
      { cols: 1, rows: 1 },
    ])
  })

  it('never leaves a hole, whatever the category count', () => {
    // The count comes from the data. A sixth department must not open a gap in
    // the grid because nobody re-drew it by hand.
    for (let n = 1; n <= 12; n++) {
      const tiles = bentoLayout(n)
      expect(tiles).toHaveLength(n)
      const grid = pack(tiles)
      grid.forEach((row, r) => expect(row.every(Boolean), `n=${n}, row ${r}`).toBe(true))
    }
  })

  it('gives a lone category the whole width', () => {
    expect(bentoLayout(1)).toEqual([{ cols: 4, rows: 2 }])
  })

  it('returns nothing for nothing', () => {
    expect(bentoLayout(0)).toEqual([])
  })
})
