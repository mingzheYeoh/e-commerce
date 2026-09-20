import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { products } from './products'
import { categories } from './categories'
import { brands } from './brands'

/**
 * Every picture the catalogue names has to be on disk.
 *
 * This exists because nothing else fails when one is missing. The site is
 * served with `not_found_handling: "single-page-application"`, so a request for
 * an absent image returns the app shell with a 200 — the browser gets HTML
 * where it wanted a picture, renders nothing, and no log anywhere says why.
 *
 * The phones category card was blank for a week that way: the category was
 * added to the data and never added to the asset pipeline's job table. Six
 * brand tiles were blank for the same reason.
 */
const asset = (url: string) => path.join(process.cwd(), 'public', url.replace(/^\//, ''))

describe('catalogue media', () => {
  it('has the hero image and thumbnail for every product', () => {
    const missing = products.flatMap((p) =>
      [p.media.heroImage, p.media.thumb].filter((url) => !existsSync(asset(url))).map((url) => `${p.id}: ${url}`),
    )
    expect(missing).toEqual([])
  })

  it('has a picture for every category', () => {
    // The one that started this. A category with no image is a card that is
    // just a coloured rectangle with text on it.
    const missing = categories.filter((c) => !existsSync(asset(c.image))).map((c) => c.id)
    expect(missing).toEqual([])
  })

  it('has a preview for every brand', () => {
    const missing = brands
      .filter((b) => b.previewImage && !existsSync(asset(b.previewImage)))
      .map((b) => b.id)
    expect(missing).toEqual([])
  })

  it('tolerates a short gallery, because the pipeline writes what it found', () => {
    // Deliberately NOT asserted as complete. Commons rarely holds four
    // photographs of one model, and ProductPage probes each candidate and shows
    // the ones that load. This asserts the first is always there, since that is
    // the one the card and the cart use.
    for (const p of products) {
      expect(p.media.gallery[0], `${p.id} has no first gallery image`).toBe(p.media.heroImage)
    }
  })
})
