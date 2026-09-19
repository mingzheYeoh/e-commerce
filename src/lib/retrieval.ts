/**
 * Ranking and scoring primitives, shared by the live search and the offline
 * evaluation.
 *
 * They live together on purpose: if the eval script reimplemented fusion, it
 * would be measuring code that never runs in front of a shopper, and the
 * numbers would drift away from the product without anything failing.
 */

/**
 * Cosine similarity, given both vectors are already L2-normalised — which the
 * embedding step guarantees, so the division is done once at build time rather
 * than on every comparison at query time.
 */
export function dot(query: Float32Array, corpus: Float32Array, offset: number, dims: number): number {
  let sum = 0
  for (let i = 0; i < dims; i++) sum += query[i] * corpus[offset + i]
  return sum
}

/**
 * Reciprocal rank fusion.
 *
 * Adding the two engines' scores directly would require the keyword engine's
 * arbitrary point scale and the model's cosine range to mean the same thing.
 * They do not, and normalising them invents a relationship that is not there.
 * Fusing *positions* needs no such assumption: each list contributes
 * 1/(k + rank), so agreement between the two is what lifts a result.
 *
 * k = 60 is the value from the original RRF paper; it flattens the curve enough
 * that one engine's confident first place cannot single-handedly win.
 */
export function fuseRanks(lists: string[][], k = 60): string[] {
  const scores = new Map<string, number>()
  for (const list of lists) {
    list.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1)))
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
}

/* ------------------------------------------------------------------ metrics */

/** Share of the top k that was relevant. Punishes padding the results out. */
export function precisionAt(ranked: string[], relevant: string[], k: number): number {
  return ranked.slice(0, k).filter((id) => relevant.includes(id)).length / k
}

/** Share of everything relevant that reached the top k. Punishes misses. */
export function recallAt(ranked: string[], relevant: string[], k: number): number {
  if (!relevant.length) return 0
  return relevant.filter((id) => ranked.slice(0, k).includes(id)).length / relevant.length
}

/**
 * 1 / rank of the first relevant hit, 0 if none.
 *
 * This is the metric that tracks what a shopper feels: a right answer in the
 * first slot scores 1.0, the same answer in the fifth scores 0.2, and precision
 * cannot tell those apart.
 */
export function reciprocalRank(ranked: string[], relevant: string[]): number {
  const i = ranked.findIndex((id) => relevant.includes(id))
  return i === -1 ? 0 : 1 / (i + 1)
}
