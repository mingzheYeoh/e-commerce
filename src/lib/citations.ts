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

/**
 * Links product names the model wrote without a marker.
 *
 * Asked to cite as `[id]`, the model complies most of the time and sometimes
 * just writes "The OnePlus 15 charges at 120W". The citation cards below the
 * answer still appear, so the reader sees the product named in prose and again
 * as a card, with only the card clickable — for no reason they could guess.
 *
 * Only ids already established as relevant are linked, and only whole words, so
 * this cannot invent a link to something the answer never mentioned. Longest
 * titles first: "iPhone 18 Pro Max" must win over "iPhone 18 Pro".
 */
function linkBareTitles(
  text: string,
  known: { id: string; title: string }[],
): Segment[] {
  const byLength = [...known].sort((a, b) => b.title.length - a.title.length)
  let out: Segment[] = [{ kind: 'text', value: text }]

  for (const { id, title } of byLength) {
    const next: Segment[] = []
    for (const seg of out) {
      if (seg.kind !== 'text') {
        next.push(seg)
        continue
      }
      const pattern = new RegExp(`\\b${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
      const m = seg.value.match(pattern)
      if (!m) {
        next.push(seg)
        continue
      }
      const at = m.index!
      if (at > 0) next.push({ kind: 'text', value: seg.value.slice(0, at) })
      next.push({ kind: 'cite', id, title })
      const rest = seg.value.slice(at + m[0].length)
      if (rest) next.push({ kind: 'text', value: rest })
    }
    out = next
  }
  return out
}

export function toSegments(
  text: string,
  titleOf: (id: string) => string | undefined,
  /** Ids the answer is known to rest on, used only when it cited none inline. */
  fallbackIds: string[] = [],
): Segment[] {
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

  // Nothing was cited inline. Fall back to linking the names of the products
  // the answer is already known to rest on.
  if (!out.some((s) => s.kind === 'cite') && fallbackIds.length) {
    const known = fallbackIds
      .map((id) => ({ id, title: titleOf(id) }))
      .filter((k): k is { id: string; title: string } => Boolean(k.title))
    if (known.length) return linkBareTitles(text, known)
  }

  return out
}
