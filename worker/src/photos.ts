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

/*
 * Customer photos, the same pipeline: resized in the browser, webp checked
 * here, keys minted here.
 *
 *   avatars/<user>/<name>.webp                 256px, public
 *   reviews/<review>/<name>-1600.webp | -400   public
 *   returns/<request>/<name>.webp              PRIVATE bucket, never public
 *
 * Avatars and review photos sit in the public MEDIA bucket beside product
 * photos and are served by the same /media/u route. Return photos go to a
 * separate bucket, and isPhotoKey refuses their shape, so no misconfigured
 * binding can ever put one behind the public route.
 */
export const MAX_AVATAR_BYTES = 100_000
export const MAX_REVIEW_PHOTOS = 3
export const MAX_RETURN_PHOTOS = 3

export const avatarKey = (userId: string, name: string) => `avatars/${userId}/${name}.webp`
export const reviewKey = (reviewId: string, name: string, size: 1600 | 400) => `reviews/${reviewId}/${name}-${size}.webp`
export const returnKey = (returnId: string, name: string) => `returns/${returnId}/${name}.webp`

/** Every public key this module can mint, and nothing else. The serving route checks it. */
export const isPhotoKey = (key: string) =>
  /^products\/mch_[a-z0-9]+\/prd_[a-z0-9]+\/ph_[a-z0-9]+-(1600|400)\.webp$/.test(key) ||
  /^avatars\/usr_[A-Za-z0-9]+\/ph_[a-z0-9]+\.webp$/.test(key) ||
  /^reviews\/rev_[a-z0-9]+\/ph_[a-z0-9]+-(1600|400)\.webp$/.test(key)

/** A return photo key's request and name, or null for any key returnKey would not mint. */
export function isReturnKey(key: string): { returnId: string; name: string } | null {
  const m = key.match(/^returns\/(ret_[a-z0-9]+)\/(ph_[a-z0-9]+)\.webp$/)
  return m ? { returnId: m[1], name: m[2] } : null
}

/** A review photo's two URLs. */
export const reviewPhotoUrls = (base: string, reviewId: string, name: string) => ({
  large: base + reviewKey(reviewId, name, 1600),
  thumb: base + reviewKey(reviewId, name, 400),
})

/** RIFF....WEBP: the first twelve bytes of every webp file. */
export function isWebp(bytes: Uint8Array): boolean {
  const tag = (from: number) => String.fromCharCode(...bytes.subarray(from, from + 4))
  return bytes.length >= 12 && tag(0) === 'RIFF' && tag(8) === 'WEBP'
}

/**
 * The webp files a multipart upload carries, in `parts` order, or the refusal.
 *
 * Checked before anything is stored, cheapest first. The declared length
 * comes before formData(), which buffers the whole body — an isolate has
 * 128MB against a 100MB request limit, so the cap has to hold before it runs
 * (browsers always send content-length for a FormData fetch). Then each
 * part's size, then its bytes: never the file name or declared type, which
 * are both the client's word.
 */
export async function readWebpForm(
  request: Request,
  parts: { field: string; max: number }[],
): Promise<ArrayBuffer[] | { status: 400 | 413 | 415; error: string }> {
  const tooLarge = { status: 413 as const, error: 'That photo is too large, even after resizing.' }
  const length = Number(request.headers.get('content-length'))
  if (!length || length > parts.reduce((n, p) => n + p.max, 0) + 64_000) return tooLarge
  const form = await request.formData().catch(() => null)
  const files = parts.map((p) => form?.get(p.field))
  if (!files.every((f): f is File => f instanceof File)) {
    return { status: 400, error: `Send the photo as ${parts.map((p) => p.field).join(' and ')}.` }
  }
  if (files.some((f, i) => f.size > parts[i].max)) return tooLarge
  const bytes = await Promise.all(files.map((f) => f.arrayBuffer()))
  if (!bytes.every((b) => isWebp(new Uint8Array(b)))) return { status: 415, error: 'Photos are uploaded as webp.' }
  return bytes
}

/**
 * A private photo (a return's) as a response. Never stored by anything in
 * between: it is only ever sent to someone the route has just authorised.
 */
export const privatePhoto = (object: R2ObjectBody) =>
  new Response(object.body, {
    headers: {
      'content-type': 'image/webp',
      'cache-control': 'private, no-store',
      // Only the first twelve bytes were checked at upload.
      'x-content-type-options': 'nosniff',
    },
  })

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
