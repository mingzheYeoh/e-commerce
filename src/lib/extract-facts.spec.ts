import { describe, it, expect } from 'vitest'
import { extractFacts } from './extract-facts'
import { products } from '@/data/products'

const find = (id: string) => {
  const p = products.find((x) => x.id === id)
  if (!p) throw new Error(`fixture product ${id} is gone — update this test`)
  return p
}

describe('extractFacts', () => {
  it('reads the figures a comparative question needs', () => {
    const iphone = extractFacts(find('iphone-18-pro'))
    expect(iphone.batteryHours).toBe(36)
    expect(iphone.screenInches).toBe(6.3)
    expect(iphone.megapixels).toBe(48)
    expect(iphone.features).toContain('eSIM')
  })

  it('prefers the wired charging figure over the wireless one', () => {
    // "60W wired, 15W wireless" — a shopper comparing charge speed means the
    // wired number, and a naive first-match would return 15 for some orderings.
    const s26 = extractFacts(find('galaxy-s26-ultra'))
    expect(s26.chargeWatts).toBe(60)
    expect(s26.batteryMah).toBe(5000)
  })

  it('separates memory from storage rather than taking the first GB it sees', () => {
    const zen = extractFacts(find('zenbook-s14'))
    expect(zen.memoryGb).toBe(32)
    expect(zen.storageGb).toBe(1024) // 1TB, normalised to GB so it compares
  })

  it('detects capabilities without firing on unrelated wording', () => {
    expect(extractFacts(find('qc-ultra')).features).toContain('Active noise cancellation')
    // A wireless mouse is wireless; it does not charge wirelessly.
    expect(extractFacts(find('viper-v3')).features).not.toContain('Wireless charging')
  })

  it('finds USB-C however a vendor spells it', () => {
    const withUsbC = products.filter((p) => extractFacts(p).ports.includes('USB-C'))
    expect(withUsbC.length).toBeGreaterThan(5)
  })

  it('leaves a fact undefined rather than inventing one', () => {
    // Every product must parse without throwing, and nothing may come back NaN:
    // a wrong number answers a comparison incorrectly, which is worse than
    // declining to answer it.
    for (const p of products) {
      const f = extractFacts(p)
      for (const [key, value] of Object.entries(f)) {
        if (typeof value === 'number') {
          expect(Number.isFinite(value), `${p.id}.${key} is not finite`).toBe(true)
          expect(value, `${p.id}.${key} should be positive`).toBeGreaterThan(0)
        }
      }
    }
  })

  it('covers most of the catalogue with at least one usable fact', () => {
    const withFacts = products.filter((p) => {
      const f = extractFacts(p)
      return f.features.length > 0 || f.ports.length > 0 || f.batteryHours || f.screenInches
    })
    expect(withFacts.length / products.length).toBeGreaterThan(0.8)
  })
})

describe('extractFacts — numbers read out of real spec prose', () => {
  it('reads a two-decimal measurement whole, not from its middle', () => {
    // "6.78in" was parsed as 78 inches: without a boundary before the digits the
    // pattern is free to start after the decimal point. The graph then answered
    // "largest screen" with a phone.
    expect(extractFacts(find('oneplus-15')).screenInches).toBe(6.78)
    expect(extractFacts(find('fx3-cinema')).megapixels).toBe(10.2)
  })

  it('does not mistake a sensor size for a screen size', () => {
    // "50MP 1in Light Fusion" and "Sensor: 1in CMOS" are sensors. The Osmo's
    // actual screen is 2in, and the Xiaomi's is 6.9in.
    expect(extractFacts(find('xiaomi-17-ultra')).screenInches).toBe(6.9)
    expect(extractFacts(find('osmo-pocket')).screenInches).toBe(2)
  })

  it('takes the headline battery figure, not a fast-charge claim', () => {
    // "70 days, 1 min charge = 3 hours" — the 3 is what a minute of charging
    // buys, not what the mouse lasts.
    const mx = extractFacts(find('mx-master'))
    expect(mx.batteryHours).toBe(70 * 24)
  })
})
