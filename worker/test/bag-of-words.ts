/**
 * A stand-in embedding model: a hashed, L2-normalised bag of words.
 *
 * Deterministic, and similar enough in spirit that a query sharing words with
 * a text scores above one that does not. No worker types, so the storefront's
 * semantic spec can use it too.
 */
export const DIMS = 384

export function embed(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0)
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 0
    for (const c of word) h = (h * 31 + c.charCodeAt(0)) >>> 0
    v[h % DIMS] += 1
  }
  const norm = Math.hypot(...v) || 1
  return v.map((x) => x / norm)
}
