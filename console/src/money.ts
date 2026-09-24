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
