import { describe, it, expect } from 'vitest'
import { products } from './products'
import { categories } from './categories'
import { brands } from './brands'
import manifest from './media-manifest.json'

/**
 * Every picture the catalogue names has to exist where it points.
 *
 * This exists because nothing else fails when one is missing. The phones
 * category card was blank for a week because the category was added to the
 * data and never to the asset pipeline's job table; six brand tiles were blank
 * for the same reason.
 *
 * The pictures live on R2 behind media.nexusohm.com, not on disk. The manifest
 * lists what scripts/upload-media.mjs uploaded AND read back from the public
 * URL at the right size, so a key in it is a picture that was really served.
 */
const PREFIX = `${manifest.origin}/`
const files = manifest.files as Record<string, number>
const served = (url: string) => url.startsWith(PREFIX) && url.slice(PREFIX.length) in files

describe('catalogue media', () => {
  it('has the hero image and thumbnail for every product', () => {
    // A /media/u/ URL is a merchant upload served by nexus-api, checked by the
    // console when it was uploaded; this test guards the asset pipeline's files.
    const upload = (url: string) => url.includes('/media/u/')
    const missing = products.flatMap((p) =>
      [p.media.heroImage, p.media.thumb]
        .filter((url) => !upload(url) && !served(url))
        .map((url) => `${p.id}: ${url}`),
    )
    expect(missing).toEqual([])
  })

  it('has a picture for every category', () => {
    // The one that started this. A category with no image is a card that is
    // just a coloured rectangle with text on it.
    const missing = categories.filter((c) => !served(c.image)).map((c) => c.id)
    expect(missing).toEqual([])
  })

  it('has a preview for every brand', () => {
    const missing = brands
      .filter((b) => b.previewImage && !served(b.previewImage))
      .map((b) => b.id)
    expect(missing).toEqual([])
  })

  it('leads every gallery with the hero image', () => {
    // The card and the cart use the first picture, so it is the hero.
    for (const p of products) {
      expect(p.media.gallery[0], `${p.id} has no first gallery image`).toBe(p.media.heroImage)
    }
  })

  it('has every gallery picture it names', () => {
    // It used to tolerate gaps, because ProductPage probes each candidate and
    // hides the ones that fail. Five did fail, silently, for weeks: the
    // gallery promised four views and showed three. Every slot is filled now,
    // so a missing one is a regression again.
    const missing = products.flatMap((p) =>
      p.media.gallery.filter((url) => !url.includes('/media/u/') && !served(url)).map((url) => `${p.id}: ${url}`),
    )
    expect(missing).toEqual([])
  })
})
