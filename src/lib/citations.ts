/**
 * Turns a model's cited answer into renderable segments.
 *
 * The model is asked to write `[product-id]`. What it actually writes varies:
 * sometimes the marker alone, more often the marker followed by the product's
 * name, and occasionally an id for something that was never retrieved.
 * Tightening the prompt makes each of those rarer without making any of them
 * impossible, so all three are handled here, where they can be detected for
 * certain rather than discouraged.
 */

export type Segment =
  | { kind: 'text'; value: string }
  | { kind: 'cite'; id: string; title: string }

export function toSegments(text: string, titleOf: (id: string) => string | undefined): Segment[] {
  const out: Segment[] = []
  let last = 0

  for (const m of text.matchAll(/\[([a-z0-9-]+)\]/gi)) {
    const title = titleOf(m[1])
    // An id naming something that was never retrieved stays as literal text: a
    // link to a product that may not exist is worse than a visible artefact.
    if (!title) continue

    if (m.index! > last) out.push({ kind: 'text', value: text.slice(last, m.index) })
    out.push({ kind: 'cite', id: m[1], title })
    last = m.index! + m[0].length

    // "[gan-charger] Prime 250W GaN Charger" would otherwise render the name
    // twice, once as the link and once as the following prose.
    const rest = text.slice(last)
    const after = rest.replace(/^\s+/, '')
    if (after.toLowerCase().startsWith(title.toLowerCase())) {
      last += rest.length - after.length + title.length
    }
  }

  if (last < text.length) out.push({ kind: 'text', value: text.slice(last) })
  return out
}
