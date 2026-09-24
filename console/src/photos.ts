/**
 * Resizes a photo in the browser before upload, so the worker never decodes
 * an image and the storefront never downloads a phone's 5MB original.
 *
 * Canvas and createImageBitmap are native; no dependency does this better
 * for two fixed sizes. The worker re-checks the result (bytes, size), so
 * nothing here is a security boundary.
 */
export async function toWebp(file: File, maxSide: number): Promise<Blob> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    // HEIC from an iPhone is the usual cause: most browsers cannot decode it.
    throw new Error(`${file.name} could not be read. Use a JPG, PNG or WebP photo.`)
  }
  // The longer side, so a tall screenshot shrinks as much as a wide photo.
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.82))
  // A browser that cannot encode webp silently hands back a PNG instead.
  if (!blob || blob.type !== 'image/webp') {
    throw new Error('This browser cannot save WebP images. Try Chrome, Edge or Firefox.')
  }
  return blob
}

/** The photo's name, from its gallery URL: .../<name>-1600.webp */
export const photoName = (url: string) => url.slice(url.lastIndexOf('/') + 1).replace(/-1600\.webp$/, '')

export const thumbOf = (url: string) => url.replace(/-1600\.webp$/, '-400.webp')
