import { catalogue } from '@/stores/catalog'
import { brands } from '@/data/brands'
import type { Product, CategoryId } from '@/types'

/**
 * Turns a sentence into a product shortlist.
 *
 * This is a local intent engine, not a language model: it pulls *structured
 * constraints* out of free text — a budget, a use case, a category, a brand —
 * and scores the catalogue against them. That is the part of "AI search" that
 * actually changes which products a shopper sees, and it runs offline, in a
 * fraction of a millisecond, with no key to leak.
 *
 * It cannot answer open-ended questions. `explain()` says what it understood so
 * a shopper is never guessing why these results came back — and so the seam is
 * visible when it understood nothing.
 *
 * The whole module sits behind `recommend()`; swapping in a server-side model
 * later is a change to this file alone.
 */

export interface Recommendation {
  product: Product
  score: number
  reasons: string[]
}

export interface RecommendResult {
  items: Recommendation[]
  understood: string[]
  budget: { value: number; strict: boolean } | null
}

/** Use cases, and the spec words that satisfy them. */
/**
 * `wants` is matched against raw product text, which has no idea what kind of
 * device it is reading. "camera" appears on phones, laptops and drones alike,
 * and a phone's "36 hours video playback" is a battery claim that happens to
 * contain the word video. `prefers` restores the missing signal: an intent
 * nudges its natural category up without excluding anything, so a phone still
 * answers "shoot 4K video" — just below the gear built for it.
 */
const INTENTS: {
  id: string
  triggers: string[]
  wants: string[]
  label: string
  prefers?: CategoryId[]
}[] = [
  {
    id: 'noise',
    triggers: ['flight', 'plane', 'flying', 'commute', 'commuting', 'train', 'office', 'noisy', 'noise', 'quiet', 'focus'],
    wants: ['noise cancellation', 'anc', 'quietcomfort'],
    label: 'blocking out noise',
    prefers: ['audio'],
  },
  {
    id: 'travel',
    triggers: ['travel', 'trip', 'portable', 'pocket', 'carry', 'lightweight', 'backpack'],
    wants: ['portable', 'battery', 'ip', 'compact'],
    label: 'travelling light',
  },
  {
    id: 'video',
    triggers: ['video', 'vlog', 'vlogging', 'film', 'filming', 'cinema', 'youtube', 'shoot', 'shooting', 'footage'],
    wants: ['4k', '6k', 'prores', 'gimbal', 'stabilis', 'cmos', 'camera'],
    label: 'shooting video',
    prefers: ['imaging'],
  },
  {
    id: 'photo',
    triggers: ['photo', 'photography', 'portrait', 'landscape', 'camera', 'shots'],
    wants: ['full-frame', 'mp', 'sensor', 'stabilisation'],
    label: 'photography',
    prefers: ['imaging'],
  },
  {
    id: 'gaming',
    triggers: ['gaming', 'game', 'games', 'fps', 'esports', 'competitive'],
    wants: ['dpi', 'polling', 'rtx', 'hz', 'mechanical'],
    label: 'gaming',
  },
  {
    id: 'work',
    triggers: ['work', 'working', 'productivity', 'coding', 'programming', 'developer', 'desk', 'home office', 'meetings', 'calls'],
    wants: ['multi-device', 'battery', 'retina', 'core', 'webcam'],
    label: 'working',
  },
  {
    id: 'studio',
    triggers: ['studio', 'mixing', 'mastering', 'produce', 'producing', 'music', 'recording', 'podcast'],
    wants: ['reference', 'open-back', 'thd', '32-bit', '96khz', 'transducer'],
    label: 'studio work',
  },
  {
    id: 'battery',
    triggers: ['battery', 'long lasting', 'all day', 'charge', 'charging', 'power'],
    wants: ['hour', 'mah', 'battery', 'w '],
    label: 'long battery life',
  },
  {
    id: 'running',
    triggers: ['running', 'run', 'gym', 'workout', 'exercise', 'sport', 'swim', 'hiking', 'outdoor'],
    wants: ['ip', 'water', 'gps', 'open-ear'],
    label: 'workouts and the outdoors',
  },
]

/**
 * Everyday words for each department.
 *
 * Typed against `CategoryId` rather than `string` on purpose: a new category
 * with no words here is a compile error, not a search that silently answers the
 * wrong department. 'phone' sat under `computing` until phones became their own
 * category, and nothing caught it — build, typecheck and tests all stayed green
 * while "I need a new phone" returned laptops.
 */
const CATEGORY_WORDS: Record<CategoryId, string[]> = {
  phones: ['phone', 'phones', 'smartphone', 'handset', 'iphone', 'android', 'galaxy', 'pixel'],
  audio: ['headphone', 'headphones', 'earbud', 'earbuds', 'earphone', 'speaker', 'audio', 'sound', 'music', 'listen', 'synth', 'recorder'],
  peripherals: ['keyboard', 'mouse', 'mice', 'monitor', 'display', 'desk setup', 'typing', 'switches'],
  imaging: ['camera', 'drone', 'gimbal', 'webcam', 'lens', 'aerial', 'quadcopter'],
  computing: ['laptop', 'macbook', 'watch', 'smartwatch', 'charger', 'power bank', 'computer', 'tablet'],
}

/**
 * "under 500", "below $1,200", "around 300", "$800 budget".
 *
 * `strict` matters: "under 200" is a ceiling a shopper means literally, so
 * anything above it is removed rather than merely ranked lower. "around 300" is
 * an estimate, so a $340 product is still a fair answer.
 */
function extractBudget(text: string): { value: number; strict: boolean } | null {
  const cleaned = text.replace(/,/g, '')

  const ceiling = cleaned.match(/(?:under|below|less than|max|up to|within|no more than)\s*\$?\s*(\d{2,6})/)
  if (ceiling) return { value: Number(ceiling[1]), strict: true }

  const around = cleaned.match(/(?:around|about|roughly)\s*\$?\s*(\d{2,6})/)
  if (around) return { value: Number(around[1]) * 1.2, strict: false }

  const dollars = cleaned.match(/\$\s*(\d{2,6})/)
  if (dollars) return { value: Number(dollars[1]), strict: false }

  const budgetWord = cleaned.match(/(\d{2,6})\s*(?:dollars|usd|budget)/)
  if (budgetWord) return { value: Number(budgetWord[1]), strict: false }

  return null
}

const haystackOf = (p: Product) =>
  `${p.title} ${p.brand} ${p.specsSummary.join(' ')}`.toLowerCase()

export function recommend(query: string, limit = 6): RecommendResult {
  const text = query.toLowerCase().trim()
  const understood: string[] = []

  if (!text) return { items: [], understood, budget: null }

  const budget = extractBudget(text)
  if (budget) {
    understood.push(
      budget.strict
        ? `under $${Math.round(budget.value)}`
        : `budget around $${Math.round(budget.value)}`,
    )
  }

  const intents = INTENTS.filter((i) => i.triggers.some((t) => text.includes(t)))
  for (const intent of intents) understood.push(intent.label)

  const category = Object.entries(CATEGORY_WORDS).find(([, words]) =>
    words.some((w) => text.includes(w)),
  )?.[0]
  if (category) understood.push(`${category} products`)

  const brand = brands.find((b) => text.includes(b.name.toLowerCase()))
  if (brand) understood.push(brand.name)

  const wantsCheap = /cheap|budget|affordable|value|inexpensive/.test(text)
  const wantsBest = /best|top|premium|flagship|pro\b|highest|ultimate/.test(text)
  if (wantsCheap) understood.push('lower prices first')
  if (wantsBest) understood.push('top rated first')

  const scored = catalogue.value.map((product) => {
    const hay = haystackOf(product)
    const reasons: string[] = []
    let score = 0
    // budget.value is parsed from the shopper's sentence in dollars; the
    // catalogue speaks minor units, so the one conversion happens here.
    const price = product.priceMinor / 100

    if (!product.inStock) score -= 6

    if (category && product.category === category) {
      score += 10
      reasons.push('matches the category you described')
    }
    if (brand && product.brand === brand.id) {
      score += 8
      reasons.push(`made by ${brand.name}`)
    }

    for (const intent of intents) {
      const hits = intent.wants.filter((w) => hay.includes(w)).length
      if (hits) {
        score += 5 + hits * 2
        if (intent.prefers?.includes(product.category)) score += 6
        reasons.push(`suited to ${intent.label}`)
      }
    }

    if (budget) {
      if (price <= budget.value) {
        score += 6
        reasons.push(`within your budget at $${price.toLocaleString('en-US')}`)
      } else if (budget.strict) {
        // "under 200" is a ceiling, not a preference.
        score = -Infinity
      } else {
        // An estimate, so a near miss can still surface, weighted by overshoot.
        score -= Math.min(14, ((price - budget.value) / budget.value) * 12)
      }
    }

    // Any literal word overlap still counts — someone typing a model name
    // should get that model.
    const words = text.split(/[^a-z0-9]+/).filter((w) => w.length > 3)
    const literal = words.filter((w) => hay.includes(w)).length
    score += literal * 3

    // A product nobody has reviewed yet (anything new from the console) is
    // neutral, not a zero-star product: rating 0 would cost it 4 points and
    // bury it under an exact name match.
    const rating = product.reviewCount > 0 ? product.rating : 4
    score += rating - 4
    if (wantsBest) score += (rating - 4) * 4
    if (wantsCheap) score -= price / 400
    if (score === -Infinity) return { product, score, reasons: [] }

    return { product, score, reasons: [...new Set(reasons)] }
  })

  const items = scored
    .filter((r) => r.score > 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)

  return { items, understood, budget }
}
