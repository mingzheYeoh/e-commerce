/**
 * UTC calendar dates as `YYYY-MM-DD`, the way the worker stores and filters
 * them. Every range here is inclusive at both ends.
 */
const DAY = 86_400_000
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const ms = (day: string) => Date.parse(`${day}T00:00:00Z`)

export const addDays = (day: string, n: number) => iso(ms(day) + n * DAY)

export type Preset = '7' | '30' | '90' | 'month' | 'last-month'

export const PRESETS: { id: Preset; label: string }[] = [
  { id: '7', label: '7 days' },
  { id: '30', label: '30 days' },
  { id: '90', label: '90 days' },
  { id: 'month', label: 'This month' },
  { id: 'last-month', label: 'Last month' },
]

/** `YYYY-MM` -> its first and last day. */
export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number)
  return { from: iso(Date.UTC(y, m - 1, 1)), to: iso(Date.UTC(y, m, 0)) }
}

export function presetRange(preset: Preset, now = Date.now()): { from: string; to: string } {
  const today = iso(now)
  if (preset === 'month') return { from: `${today.slice(0, 7)}-01`, to: today }
  if (preset === 'last-month') return monthRange(addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7))
  return { from: addDays(today, 1 - Number(preset)), to: today }
}

/** Every bucket's first day from `from` to `to`, `size` days apart: the chart's x axis, gaps included. */
export function buckets(from: string, to: string, size: number): string[] {
  const out: string[] = []
  for (let d = from; d <= to; d = addDays(d, size)) out.push(d)
  return out
}
