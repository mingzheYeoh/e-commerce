/**
 * Pulls comparable numbers and discrete capabilities out of spec prose.
 *
 * This is the layer the embedding model cannot provide. A vector knows that
 * "Up to 36 hours video playback" is *about* battery; it cannot tell you that 36
 * is larger than 20, so "which lasts longest" and "over 50W charging" are
 * unanswerable by similarity alone. Turning the prose into typed facts is what
 * makes those queries a lookup instead of a guess.
 *
 * Parsing is deliberately conservative: a spec line that does not clearly state
 * a figure yields nothing rather than a number invented from a partial match.
 * A missing fact degrades a query; a wrong one answers it incorrectly.
 */
import type { Product } from '@/types'

export interface ProductFacts {
  batteryHours?: number
  batteryMah?: number
  chargeWatts?: number
  screenInches?: number
  refreshHz?: number
  megapixels?: number
  storageGb?: number
  memoryGb?: number
  ports: string[]
  features: string[]
}

const specText = (p: Product) =>
  [...p.specsSummary, ...p.specs.map((s) => `${s.label}: ${s.value}`)].join(' | ')

/**
 * Spec lines whose label or value mentions a subject, for facts that are only
 * meaningful in context.
 *
 * Searching the whole blob for "Hz" gave the WH-1000XM6 a refresh rate, because
 * its frequency response reads "4 Hz - 40,000 Hz" and the digits before "Hz"
 * matched. Headphones do not have refresh rates; the fix is to ask the right
 * lines rather than to make the pattern cleverer.
 */
const linesAbout = (p: Product, subject: RegExp) =>
  p.specs
    .filter((s) => subject.test(s.label) || subject.test(s.value))
    .map((s) => `${s.label}: ${s.value}`)
    .join(' | ')

/** First capture group of the first pattern that matches, as a number. */
function firstNumber(text: string, patterns: RegExp[]): number | undefined {
  for (const re of patterns) {
    const m = text.match(re)
    if (m?.[1]) {
      const n = Number(m[1].replace(/,/g, ''))
      if (Number.isFinite(n)) return n
    }
  }
  return undefined
}

/** Ports a product exposes, normalised so USB-C and "USB Type-C" are one thing. */
const PORTS: [RegExp, string][] = [
  [/usb[-\s]?c|type[-\s]?c|usb\s*4/i, 'USB-C'],
  [/thunderbolt/i, 'Thunderbolt'],
  [/hdmi/i, 'HDMI'],
  [/3\.5\s?mm|headphone jack/i, '3.5mm'],
  [/sd card|sdxc|microsd/i, 'SD card'],
  [/lightning/i, 'Lightning'],
  [/ethernet|rj45/i, 'Ethernet'],
]

/**
 * Capabilities a shopper filters on. Each needs a phrase distinctive enough
 * that it cannot fire on an unrelated line — "wireless" alone would match a
 * wireless mouse and claim it charges wirelessly.
 */
const FEATURES: [RegExp, string][] = [
  [/noise cancel|\banc\b|quietcomfort/i, 'Active noise cancellation'],
  [/transparency|ambient mode|open[-\s]?ear/i, 'Hear-through'],
  [/wireless charging|\bqi\b|magsafe/i, 'Wireless charging'],
  [/\bip6[7-9]\b|\bip5[4-8]\b|water resistan|waterproof/i, 'Water resistant'],
  [/oled|amoled/i, 'OLED display'],
  [/spatial audio|dolby atmos/i, 'Spatial audio'],
  [/\bnpu\b|copilot\+|neural engine|\btops\b/i, 'On-device AI accelerator'],
  [/mechanical|hot[-\s]?swap|qmk/i, 'Mechanical switches'],
  [/optical zoom|periscope|telephoto/i, 'Optical zoom'],
  [/stabilis|stabiliz|gimbal/i, 'Stabilisation'],
  [/esim/i, 'eSIM'],
  [/fast charg|\d+w wired/i, 'Fast charging'],
]

/**
 * Thunderbolt is a USB-C connector.
 *
 * Vendors that quote "3x Thunderbolt 5" never also write "USB-C", so a literal
 * reading left the MacBook Pro with no USB-C port and no charger in the whole
 * catalogue able to power it. The physical connector is the same and the port
 * accepts USB Power Delivery, so the implication belongs in the data rather
 * than in every query that has to remember it.
 */
function withImpliedPorts(ports: string[]): string[] {
  const out = [...ports]
  if (out.includes('Thunderbolt') && !out.includes('USB-C')) out.push('USB-C')
  return out
}

/** "1TB" and "512GB" both answer "how much storage", in the same unit. */
function storageIn(text: string): number | undefined {
  const tb = firstNumber(text, [/(\d(?:\.\d)?)\s*tb\b/i])
  if (tb !== undefined) return tb * 1024
  return firstNumber(text, [/(\d{3,4})\s*gb\s*(?:ssd|storage|pcie|ufs)/i, /(\d{3,4})\s*gb\b/i])
}

/**
 * A panel refresh rate, or nothing.
 *
 * `\b` matters: without it, "40,000 Hz" matches the digits "000" and yields a
 * refresh rate of zero — which passes a naive truthiness check and then poisons
 * any comparison it takes part in. The range bound is the second guard.
 */
function displayRefresh(displayText: string): number | undefined {
  const hz = firstNumber(displayText, [/\b(\d{2,3})\s*hz/i])
  return hz !== undefined && hz >= 24 && hz <= 540 ? hz : undefined
}

export function extractFacts(product: Product): ProductFacts {
  const text = specText(product)
  const displayText = linesAbout(product, /display|screen|refresh|panel|oled|amoled|lcd/i)

  return {
    // "Up to 36 hours video playback", "20 hours with ANC on"
    batteryHours: firstNumber(text, [/(\d{1,3})\s*hours?\b/i, /(\d{1,3})\s*-?\s*hour\b/i]),
    batteryMah: firstNumber(text, [/([\d,]{3,6})\s*mah/i]),
    // "60W wired, 15W wireless" -> the wired figure, which is the headline one.
    chargeWatts: firstNumber(text, [/(\d{1,3})\s*w\s*wired/i, /(\d{1,3})\s*w\b(?!\s*wireless)/i]),
    screenInches: firstNumber(text, [/(\d{1,2}(?:\.\d)?)\s*in\b/i, /(\d{1,2}(?:\.\d)?)\s*-?inch/i]),
    // Scoped to display lines and bounded to plausible panel rates, so an audio
    // frequency response ("4 Hz - 40,000 Hz") can never be read as one.
    refreshHz: displayRefresh(displayText),
    megapixels: firstNumber(text, [/(\d{1,3})\s*mp\b/i]),
    storageGb: storageIn(text),
    memoryGb: firstNumber(text, [/(\d{1,3})\s*gb\s*(?:lpddr|unified|ram|memory)/i]),
    ports: withImpliedPorts(PORTS.filter(([re]) => re.test(text)).map(([, name]) => name)),
    features: FEATURES.filter(([re]) => re.test(text)).map(([, name]) => name),
  }
}
