/**
 * Product photos: what the console stores in R2, and the `media` JSON the
 * storefront reads.
 *
 * The browser resizes every photo before upload (1600px and 400px webp), so
 * the worker never decodes an image. It still trusts nothing the browser
 * says: the bytes must be webp, the sizes are capped, and every URL is built
 * here from a key this module minted — a request can name a photo, never a
 * URL.
 *
 * One photo is two objects sharing a name:
 *
 *   products/<merchant>/<product>/<name>-1600.webp   gallery, hero, hover
 *   products/<merchant>/<product>/<name>-400.webp    the card thumbnail
 *
 * so `media` only has to remember the order of names; everything else in it
 * is derived. The names are random, which makes the objects immutable (the
 * serving route caches them for a year) and unguessable.
 */
import { id } from './tenancy'

export const MAX_PHOTOS = 6
export const MAX_LARGE_BYTES = 1_500_000
export const MAX_THUMB_BYTES = 200_000

/** The shape the storefront's Product.media has. */
export interface Media {
  heroImage: string
  hoverImage?: string
  thumb: string
  gallery: string[]
}

export const newPhotoName = () => id('ph')

const NAME = /^ph_[a-z0-9]+$/
export const isPhotoName = (v: string) => NAME.test(v)

export const keyFor = (merchantId: string, productId: string, name: string, size: 1600 | 400) =>
  `products/${merchantId}/${productId}/${name}-${size}.webp`

/** Every key this module can mint, and nothing else. The serving route checks it. */
export const isPhotoKey = (key: string) =>
  /^products\/mch_[a-z0-9]+\/prd_[a-z0-9]+\/ph_[a-z0-9]+-(1600|400)\.webp$/.test(key)

/** RIFF....WEBP: the first twelve bytes of every webp file. */
export function isWebp(bytes: Uint8Array): boolean {
  const tag = (from: number) => String.fromCharCode(...bytes.subarray(from, from + 4))
  return bytes.length >= 12 && tag(0) === 'RIFF' && tag(8) === 'WEBP'
}

/** The media JSON for these names, in this order. Empty names → '{}', the column default. */
export function mediaFor(base: string, merchantId: string, productId: string, names: string[]): string {
  if (names.length === 0) return '{}'
  const url = (name: string, size: 1600 | 400) => base + keyFor(merchantId, productId, name, size)
  const media: Media = {
    heroImage: url(names[0], 1600),
    thumb: url(names[0], 400),
    gallery: names.map((n) => url(n, 1600)),
  }
  if (names[1]) media.hoverImage = url(names[1], 1600)
  return JSON.stringify(media)
}

/**
 * The ordered photo names in a stored `media`, or null when it holds anything
 * the console did not mint — the seeded catalogue's hand-curated photos, for
 * instance. The console refuses to rewrite those rather than silently
 * dropping them.
 */
export function namesIn(media: string, base: string, merchantId: string, productId: string): string[] | null {
  let gallery: unknown
  try {
    gallery = (JSON.parse(media) as { gallery?: unknown }).gallery ?? []
  } catch {
    return null
  }
  if (!Array.isArray(gallery)) return null
  const prefix = `${base}products/${merchantId}/${productId}/`
  const names: string[] = []
  for (const url of gallery) {
    if (typeof url !== 'string' || !url.startsWith(prefix) || !url.endsWith('-1600.webp')) return null
    const name = url.slice(prefix.length, -'-1600.webp'.length)
    if (!isPhotoName(name)) return null
    names.push(name)
  }
  return names
}
