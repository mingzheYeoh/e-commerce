import { describe, it, expect } from 'vitest'
import { toSegments, type Segment } from './citations'

const titles: Record<string, string> = {
  'gan-charger': 'Prime 250W GaN Charger',
  'iphone-18-pro': 'iPhone 18 Pro',
}
const titleOf = (id: string) => titles[id]

const render = (segs: Segment[]) =>
  segs.map((s) => (s.kind === 'text' ? s.value : `<${s.title}>`)).join('')

describe('toSegments', () => {
  it('links a bare citation marker', () => {
    const out = toSegments('The [iphone-18-pro] charges fast.', titleOf)
    expect(render(out)).toBe('The <iPhone 18 Pro> charges fast.')
  })

  it('does not repeat a name the model wrote after its own marker', () => {
    // The observed behaviour: the model writes both, and rendering the marker as
    // the title then prints the product twice in a row.
    const out = toSegments('The [gan-charger] Prime 250W GaN Charger supports 250W.', titleOf)
    expect(render(out)).toBe('The <Prime 250W GaN Charger> supports 250W.')
  })

  it('matches the repeated name case-insensitively', () => {
    const out = toSegments('[iphone-18-pro] IPHONE 18 PRO is here.', titleOf)
    expect(render(out)).toBe('<iPhone 18 Pro> is here.')
  })

  it('leaves an id that was never retrieved as plain text', () => {
    // A link to a product that may not exist is worse than a visible artefact.
    const out = toSegments('Try the [galaxy-z-fold-99] instead.', titleOf)
    expect(render(out)).toBe('Try the [galaxy-z-fold-99] instead.')
  })

  it('handles several citations in one sentence', () => {
    const out = toSegments('Both [gan-charger] and [iphone-18-pro] use USB-C.', titleOf)
    expect(render(out)).toBe('Both <Prime 250W GaN Charger> and <iPhone 18 Pro> use USB-C.')
    expect(out.filter((s) => s.kind === 'cite')).toHaveLength(2)
  })

  it('returns the whole answer as text when nothing is cited', () => {
    const out = toSegments("I don't have that in the catalogue.", titleOf)
    expect(out).toEqual([{ kind: 'text', value: "I don't have that in the catalogue." }])
  })

  it('keeps text that merely looks like a marker', () => {
    const out = toSegments('Rated [4.8] out of five.', titleOf)
    expect(render(out)).toBe('Rated [4.8] out of five.')
  })
})
