/**
 * Money conversion for the product forms. Price is typed in major units
 * ('19.99') and stored/sent in minor units (1999) — converted exactly once,
 * here, by splitting the string into integer whole/fractional parts rather
 * than multiplying a float by 100 (which is where '0.1' turns into
 * 10.000000000000002 in IEEE 754).
 */

/** Major-unit string -> minor units, or null for anything that isn't one. */
export function parsePriceToMinor(input: string): number | null {
  const match = input.trim().match(/^(\d+)(?:\.(\d{1,2}))?$/)
  if (!match) return null
  const [, whole, frac = ''] = match
  const minor = Number(whole) * 100 + Number(frac.padEnd(2, '0'))
  return Number.isSafeInteger(minor) ? minor : null
}

/** Minor units -> a display string in the given currency. Divides once. */
export function formatMinor(minor: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(minor / 100)
}

/**
 * A total that may span currencies, each shown on its own and never summed:
 * there is no rate to add them with. `empty` when there is nothing at all.
 */
export function formatAmounts(amounts: { currency: string; minor: number }[], empty = '—'): string {
  return amounts.length ? amounts.map((a) => formatMinor(a.minor, a.currency)).join(' · ') : empty
}

/**
 * Rows split by currency, order kept within each. A ranking is only a ranking
 * inside one currency: numbering SGD 880 above $31,200 would say it sold more.
 */
export function groupByCurrency<T extends { currency: string }>(rows: T[]): { currency: string; rows: T[] }[] {
  const groups = new Map<string, T[]>()
  for (const r of rows) groups.set(r.currency, [...(groups.get(r.currency) ?? []), r])
  return [...groups].map(([currency, rows]) => ({ currency, rows }))
}

/**
 * A daily trend split into one series per currency, each covering every day
 * (zero where that currency sold nothing), so each can be charted on its own.
 */
export function seriesByCurrency(trend: { day: string; revenue: { currency: string; minor: number }[] }[]) {
  const currencies = [...new Set(trend.flatMap((d) => d.revenue.map((a) => a.currency)))].sort()
  return currencies.map((currency) => ({
    currency,
    days: trend.map((d) => ({ day: d.day, minor: d.revenue.find((a) => a.currency === currency)?.minor ?? 0 })),
  }))
}
