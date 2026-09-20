/**
 * Which rows a comparison shows, and which of them have a winner.
 *
 * Two groups, because they answer different questions.
 *
 * `measured` rows are normalised figures with a direction, so they can carry a
 * verdict. `spec` rows are the union of every line the manufacturers publish,
 * verbatim — complete, but free text that mostly cannot be ranked.
 *
 * The union is large and thin: four peripherals produce 27 rows and *none* of
 * them is answered by all four. That is a property of the catalogue, not a bug,
 * and it is why union rows are ordered by how many products answer them and why
 * "differences only" also hides rows a single product answers alone.
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
  /**
   * At least two products publish something here.
   *
   * One value against three blanks reads as a difference but is really an
   * absence, and on a 27-row table those crowd out the rows that do compare.
   */
  comparable: boolean
  /** `measured` rows can carry a verdict; `spec` rows are published text. */
  group: 'measured' | 'spec'
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

const render = (
  label: string,
  values: (number | string | null)[],
  opts: { group: 'measured' | 'spec'; unit?: string; money?: boolean; direction?: Direction },
): RenderedRow => {
  const best = bestIndices(values, opts.direction ?? null)
  return {
    label,
    unit: opts.unit,
    money: Boolean(opts.money),
    group: opts.group,
    cells: values.map((value, i) => ({ value, best: best.has(i) })),
    same: values.every((v) => v === values[0]),
    comparable: values.filter((v) => v !== null).length >= 2,
  }
}

/**
 * The normalised figures, which are the only rows that can carry a verdict.
 *
 * A row no product publishes is dropped entirely. A line of dashes is not
 * information, and six of them push the rows that do compare off the screen.
 */
function measuredRows(items: Product[]): RenderedRow[] {
  const facts = items.map(extractFacts)
  return [...UNIVERSAL, ...BY_CATEGORY[items[0].category]].flatMap((row) => {
    const values = items.map((p, i) => row.get(p, facts[i]))
    if (values.every((v) => v === null)) return []
    return [render(row.label, values, { group: 'measured', unit: row.unit, money: row.money, direction: row.direction })]
  })
}

/**
 * Every specification line any of the products publishes, verbatim.
 *
 * Labels are matched case-insensitively so "Battery" and "battery" are one row,
 * but they are otherwise left exactly as written. Mapping "Chip" onto
 * "Processor" would be guessing at whether two manufacturers mean the same
 * thing, and a wrong merge silently compares two different figures.
 *
 * Ordered by how many products answer the row. A union across four products is
 * mostly holes — four peripherals produce 27 labels and none is answered by all
 * four — so the rows everyone fills in come first and the ones a single product
 * has sink to the bottom, where they read as the footnotes they are.
 */
function specRows(items: Product[]): RenderedRow[] {
  const display = new Map<string, string>()
  const order: string[] = []

  for (const p of items) {
    for (const spec of p.specs) {
      const key = spec.label.trim().toLowerCase()
      if (!key || display.has(key)) continue
      display.set(key, spec.label.trim())
      order.push(key)
    }
  }

  const find = (p: Product, key: string) =>
    p.specs.find((s) => s.label.trim().toLowerCase() === key)?.value ?? null

  return order
    .map((key) => {
      const values = items.map((p) => find(p, key))
      // Published text, so no unit and never a verdict.
      return render(display.get(key)!, values, { group: 'spec' })
    })
    .map((row, i) => ({ row, i, filled: row.cells.filter((c) => c.value !== null).length }))
    // Stable within equal coverage, so a manufacturer's own ordering survives.
    .sort((a, b) => b.filled - a.filled || a.i - b.i)
    .map((x) => x.row)
}

/**
 * The full table for a set of products the caller has confirmed share a
 * category: the comparable figures first, then every published spec line.
 */
export function buildRows(items: Product[]): RenderedRow[] {
  if (!items.length) return []
  return [...measuredRows(items), ...specRows(items)]
}
