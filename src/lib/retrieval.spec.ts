import { describe, it, expect } from 'vitest'
import { dot, fuseRanks, precisionAt, recallAt, reciprocalRank } from './retrieval'

describe('dot', () => {
  it('returns 1 for a vector against itself when normalised', () => {
    const v = new Float32Array([0.6, 0.8])
    expect(dot(v, v, 0, 2)).toBeCloseTo(1, 5)
  })

  it('reads the corpus at the given offset, not from the start', () => {
    // The corpus is one flat buffer of every product's vector end to end. An
    // off-by-one in the offset would silently score against a neighbouring
    // product and still return a plausible number.
    const query = new Float32Array([1, 0])
    const corpus = new Float32Array([0, 1, 1, 0])
    expect(dot(query, corpus, 0, 2)).toBeCloseTo(0, 5)
    expect(dot(query, corpus, 2, 2)).toBeCloseTo(1, 5)
  })
})

describe('fuseRanks', () => {
  it("lifts a result both engines agree on above either engine's own favourite", () => {
    const a = ['x', 'shared', 'p']
    const b = ['y', 'shared', 'q']
    expect(fuseRanks([a, b])[0]).toBe('shared')
  })

  it('keeps a result only one engine found', () => {
    // Hybrid must not silently drop what semantic search alone surfaced; that
    // recall is the reason for running two engines.
    expect(fuseRanks([['a'], ['b']])).toContain('b')
  })

  it('does not let one engine win on score magnitude alone', () => {
    // The point of fusing positions rather than scores: the keyword engine's
    // points and a cosine similarity are not on the same scale, so only rank
    // may be compared.
    const fused = fuseRanks([['solo'], ['other', 'solo']])
    expect(fused[0]).toBe('solo')
  })
})

describe('metrics', () => {
  const ranked = ['a', 'b', 'c', 'd', 'e']

  it('scores precision over the top k only', () => {
    expect(precisionAt(ranked, ['a', 'b'], 3)).toBeCloseTo(2 / 3, 5)
    expect(precisionAt(ranked, ['e'], 3)).toBe(0)
  })

  it('scores recall against everything relevant', () => {
    expect(recallAt(ranked, ['a', 'z'], 5)).toBe(0.5)
    expect(recallAt(ranked, [], 5)).toBe(0)
  })

  it('rewards a relevant hit for being first, not merely present', () => {
    expect(reciprocalRank(ranked, ['a'])).toBe(1)
    expect(reciprocalRank(ranked, ['c'])).toBeCloseTo(1 / 3, 5)
    expect(reciprocalRank(ranked, ['zzz'])).toBe(0)
  })
})
