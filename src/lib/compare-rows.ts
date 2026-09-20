/**
 * Which rows a comparison shows, and which of them have a winner.
 *
 * Rows are curated per category rather than unioned from every `specs` entry:
 * three phones union to twenty-odd rows, most of them free text like
 * "Chip: A20 Pro" that does not compare across columns.
 */
import { extractFacts, type ProductFacts } from './extract-facts'
import { brandName } from '@/data/brands'
import type { CategoryId, Product } from '@/types'

/**
 * Which way is better, where that is a fact rather than a preference.
 *
 * `null` is the interesting value. Screen size has no direction — 6.9in is not
 * better than 6.3in, it is a different phone for a different hand — and a green
 * tick on the larger number would invent a conclusion the catalogue does not
 * support.
 */
export type Direction = 'higher' | 'lower' | null

export interface CompareRow {
  label: string
  /** `null` means this product publishes no figure. Never 0. */
  get: (p: Product, f: ProductFacts) => number | string | null
  unit?: string
  /** Rendered through the currency formatter rather than as a bare number. */
  money?: boolean
  direction: Direction
}

const list = (xs: string[]) => (xs.length ? xs.join(', ') : null)

const UNIVERSAL: CompareRow[] = [
  { label: 'Price', get: (p) => p.price, money: true, direction: 'lower' },
  { label: 'Brand', get: (p) => brandName(p.brand), direction: null },
  { label: 'Rating', get: (p) => p.rating, unit: ' / 5', direction: 'higher' },
]

const SCREEN: CompareRow = {
  label: 'Screen',
  get: (_p, f) => f.screenInches ?? null,
  unit: 'in',
  // Deliberately directionless. See `Direction`.
  direction: null,
}
const REFRESH: CompareRow = {
  label: 'Refresh rate',
  get: (_p, f) => f.refreshHz ?? null,
  unit: 'Hz',
  direction: 'higher',
}
const CAMERA: CompareRow = {
  label: 'Main camera',
  get: (_p, f) => f.megapixels ?? null,
  unit: 'MP',
  direction: 'higher',
}
const BATTERY_H: CompareRow = {
  label: 'Battery life',
  get: (_p, f) => f.batteryHours ?? null,
  unit: 'h',
  direction: 'higher',
}
const BATTERY_MAH: CompareRow = {
  label: 'Battery',
  get: (_p, f) => f.batteryMah ?? null,
  unit: 'mAh',
  direction: 'higher',
}
const CHARGING: CompareRow = {
  label: 'Charging',
  get: (_p, f) => f.chargeWatts ?? null,
  unit: 'W',
  direction: 'higher',
}
const STORAGE: CompareRow = {
  label: 'Storage',
  get: (_p, f) => f.storageGb ?? null,
  unit: 'GB',
  direction: 'higher',
}
const MEMORY: CompareRow = {
  label: 'Memory',
  get: (_p, f) => f.memoryGb ?? null,
  unit: 'GB',
  direction: 'higher',
}
const PORTS: CompareRow = { label: 'Ports', get: (_p, f) => list(f.ports), direction: null }
const FEATURES: CompareRow = { label: 'Features', get: (_p, f) => list(f.features), direction: null }

/**
 * Typed as a full record so adding a category without giving it rows is a
 * compile error rather than an empty table — the same guard `CATEGORY_WORDS`
 * already carries, added after a missing entry silently returned laptops for a
 * phone search.
 */
const BY_CATEGORY: Record<CategoryId, CompareRow[]> = {
  phones: [SCREEN, REFRESH, CAMERA, BATTERY_MAH, BATTERY_H, CHARGING, STORAGE],
  computing: [MEMORY, STORAGE, SCREEN, REFRESH, BATTERY_H, CHARGING],
  audio: [BATTERY_H, PORTS, FEATURES],
  imaging: [CAMERA, BATTERY_H, PORTS],
  peripherals: [BATTERY_H, PORTS, FEATURES],
}

export interface RenderedCell {
  value: number | string | null
  /** This column wins the row. Only ever set where a winner exists. */
  best: boolean
}

export interface RenderedRow {
  label: string
  unit?: string
  money: boolean
  cells: RenderedCell[]
  /** Every column agrees, so the row can be folded away. */
  same: boolean
}

/**
 * A winner needs at least two published figures that are not equal.
 *
 * One product publishing a number does not beat three that stay silent — that
 * marks the others as worse when they are only unknown. And when every column
 * matches there is nothing to win: highlighting all four is noise wearing the
 * costume of information.
 */
function bestIndices(values: (number | string | null)[], direction: Direction): Set<number> {
  const none = new Set<number>()
  if (!direction) return none

  const numeric = values
    .map((v, i) => ({ v, i }))
    .filter((x): x is { v: number; i: number } => typeof x.v === 'number')
  if (numeric.length < 2) return none

  const target = direction === 'higher'
    ? Math.max(...numeric.map((x) => x.v))
    : Math.min(...numeric.map((x) => x.v))
  if (numeric.every((x) => x.v === target)) return none

  return new Set(numeric.filter((x) => x.v === target).map((x) => x.i))
}

/**
 * Builds the table body for a set of products, which the caller has already
 * confirmed share a category.
 *
 * A row no product publishes is dropped entirely. A line of dashes is not
 * information, and six of them push the rows that do compare off the screen.
 */
export function buildRows(items: Product[]): RenderedRow[] {
  if (!items.length) return []
  const facts = items.map(extractFacts)
  const rows = [...UNIVERSAL, ...BY_CATEGORY[items[0].category]]

  return rows.flatMap((row) => {
    const values = items.map((p, i) => row.get(p, facts[i]))
    if (values.every((v) => v === null)) return []

    const best = bestIndices(values, row.direction)
    return [
      {
        label: row.label,
        unit: row.unit,
        money: Boolean(row.money),
        cells: values.map((value, i) => ({ value, best: best.has(i) })),
        same: values.every((v) => v === values[0]),
      },
    ]
  })
}
