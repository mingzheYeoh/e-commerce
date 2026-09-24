/**
 * The text each retrieval backend actually embeds.
 *
 * Both shapes live here rather than in the scripts that build the indexes,
 * because the evaluation needs to hold one constant while varying the other.
 * When the builders each owned a private copy, "the hosted index retrieves
 * better" was unattributable: the hosted stack changed the model *and* the
 * document text in the same step, and nothing in the repo could separate them.
 */
import { extractFacts } from './extract-facts'
import type { Product } from '@/types'

/**
 * What a product "means", as a sentence. Used by the on-device index.
 *
 * Titles alone embed poorly — "Q3 Max QMK Custom" carries no signal about
 * keyboards. Folding in the brand, the category and the spec lines gives the
 * model the vocabulary a shopper would actually type, which is the whole point
 * of moving off keyword matching.
 */
export function documentFor(p: Product): string {
  return [
    p.title,
    p.brand.toLowerCase().replace(/_/g, ' '),
    p.category,
    ...p.specsSummary,
    ...p.specs.map((s) => `${s.label}: ${s.value}`),
  ].join('. ')
}

/**
 * The same product as prose, with its extracted facts appended. Used by the
 * hosted index, where a retrieved hit is also the context a model reads.
 *
 * It has to read as prose, not as a row dump: the answer is generated from this
 * text, so anything the model needs to cite must be legible in it. Extracted
 * facts are appended because a question like "which charges fastest" is
 * answered by the number, not by the marketing line.
 */
export function passageFor(p: Product): string {
  const f = extractFacts(p)
  const numbers = Object.entries(f)
    .filter(([, v]) => typeof v === 'number')
    .map(([k, v]) => `${k} ${v}`)
  return [
    `${p.title} by ${p.brand.toLowerCase().replace(/_/g, ' ')}, ${p.category}, $${p.priceMinor / 100}.`,
    p.specsSummary.join('. ') + '.',
    p.specs.map((s) => `${s.label}: ${s.value}`).join('. ') + '.',
    f.features.length ? `Features: ${f.features.join(', ')}.` : '',
    f.ports.length ? `Ports: ${f.ports.join(', ')}.` : '',
    numbers.length ? `Figures: ${numbers.join(', ')}.` : '',
  ]
    .filter(Boolean)
    .join(' ')
}
