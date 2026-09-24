/**
 * The slice of R2Bucket the console and the media route use — put, get,
 * delete — over a Map, so tests can assert what was stored and what was not.
 */
export interface MemoryR2 {
  bucket: R2Bucket
  objects: Map<string, { bytes: Uint8Array; contentType?: string }>
}

export function memoryR2(): MemoryR2 {
  const objects: MemoryR2['objects'] = new Map()
  const bucket = {
    async put(key: string, value: ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }) {
      objects.set(key, { bytes: new Uint8Array(value), contentType: opts?.httpMetadata?.contentType })
      return { key }
    },
    async get(key: string) {
      const o = objects.get(key)
      return o ? { body: new Blob([o.bytes]).stream(), httpEtag: `"${key}"` } : null
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k)
    },
  }
  return { bucket: bucket as unknown as R2Bucket, objects }
}

/** The smallest byte string isWebp accepts: RIFF, a length, WEBP. */
export const webpBytes = (extra = 0) => {
  const b = new Uint8Array(12 + extra)
  b.set([..."RIFF"].map((c) => c.charCodeAt(0)), 0)
  b.set([..."WEBP"].map((c) => c.charCodeAt(0)), 8)
  return b
}
