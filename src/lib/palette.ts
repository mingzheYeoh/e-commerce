import type { Brand, Category, Product } from '@/types'

/**
 * The search palette's logic, kept out of the component so it can be tested
 * without mounting a dialog: which groups show, in what order, where each row
 * goes, and the recent-search memory.
 */

export type PaletteRow =
  | { kind: 'product'; product: Product; reasons: string[] }
  | { kind: 'category'; category: Category }
  | { kind: 'brand'; brand: Brand }
  | { kind: 'ask'; query: string }
  | { kind: 'recent'; query: string }

export interface PaletteGroup {
  label: string
  rows: PaletteRow[]
  /** Flat index of this group's first row: the keyboard cursor spans groups. */
  start: number
}

const words = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)

/**
 * A query word matches a label word it begins ("so" → Sony, "camera" →
 * Cameras). Whole-word prefixes only, so "phones" is not found inside
 * "headphones", and single letters match nothing — every label has an "a".
 */
function matches(query: string, label: string): boolean {
  const q = words(query).filter((w) => w.length >= 2)
  const l = words(label)
  return q.some((qw) => l.some((lw) => lw.startsWith(qw)))
}

export const matchCategories = (query: string, list: Category[], limit = 3) =>
  list.filter((c) => matches(query, `${c.label} ${c.id}`)).slice(0, limit)

export const matchBrands = (query: string, list: Brand[], limit = 3) =>
  list.filter((b) => matches(query, `${b.name} ${b.id}`)).slice(0, limit)

export function groupResults(
  query: string,
  products: { product: Product; reasons: string[] }[],
  categories: Category[],
  brands: Brand[],
): PaletteGroup[] {
  const q = query.trim()
  const candidates: [string, PaletteRow[]][] = [
    ['Products', products.map((r) => ({ kind: 'product' as const, ...r }))],
    ['Categories', matchCategories(q, categories).map((category) => ({ kind: 'category' as const, category }))],
    ['Brands', matchBrands(q, brands).map((brand) => ({ kind: 'brand' as const, brand }))],
    ['Ask AI', q ? [{ kind: 'ask' as const, query: q }] : []],
  ]
  return numbered(candidates)
}

/** Drops empty groups and gives each the flat index of its first row. */
export function numbered(candidates: [string, PaletteRow[]][]): PaletteGroup[] {
  let start = 0
  return candidates
    .filter(([, rows]) => rows.length)
    .map(([label, rows]) => {
      const group = { label, rows, start }
      start += rows.length
      return group
    })
}

export const flatten = (groups: PaletteGroup[]) => groups.flatMap((g) => g.rows)

export function rowTarget(row: PaletteRow): string | null {
  switch (row.kind) {
    case 'product':
      return `/product/${row.product.id}`
    case 'category':
      return `/shop?category=${encodeURIComponent(row.category.id)}`
    case 'brand':
      return `/shop?brand=${encodeURIComponent(row.brand.id)}`
    case 'ask':
      return `/ask?q=${encodeURIComponent(row.query)}`
    case 'recent':
      return null
  }
}

/** Moves the cursor by `delta`, wrapping at both ends. */
export const step = (cursor: number, delta: number, count: number) =>
  count ? (cursor + delta + count) % count : 0

/** The most reviewed products, as a stand-in for "popular". */
export const popular = (list: Product[], n = 3) =>
  [...list].sort((a, b) => b.reviewCount - a.reviewCount).slice(0, n)

export const RECENT_KEY = 'nexus:recent-searches'
const RECENT_MAX = 5

/** Per-browser convenience: blocked or corrupt storage reads as no history. */
export function readRecent(storage: Storage = localStorage): string[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(parsed)
      ? parsed.filter((q): q is string => typeof q === 'string').slice(0, RECENT_MAX)
      : []
  } catch {
    return []
  }
}

/** Records a search, newest first, case-insensitively deduplicated. */
export function pushRecent(query: string, storage: Storage = localStorage): string[] {
  const q = query.trim()
  const current = readRecent(storage)
  if (!q) return current
  const next = [q, ...current.filter((r) => r.toLowerCase() !== q.toLowerCase())].slice(0, RECENT_MAX)
  try {
    storage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    /* blocked storage: remembered until the page reloads, via the return value */
  }
  return next
}

export function clearRecent(storage: Storage = localStorage) {
  try {
    storage.removeItem(RECENT_KEY)
  } catch {
    /* blocked storage: nothing was saved there to clear */
  }
}

/** A stable identity for a row, so a re-ranked list can be told from the same one. */
export function rowKey(row: PaletteRow): string {
  switch (row.kind) {
    case 'product':
      return `p:${row.product.id}`
    case 'category':
      return `c:${row.category.id}`
    case 'brand':
      return `b:${row.brand.id}`
    default:
      return `${row.kind}:${row.query}`
  }
}
