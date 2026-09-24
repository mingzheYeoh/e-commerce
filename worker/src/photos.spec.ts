// @vitest-environment node
import { describe, it, expect } from 'vitest'
import worker, { type Env } from './index'
import { isPhotoKey, isWebp, keyFor, mediaFor, namesIn } from './photos'
import { memoryR2, webpBytes } from '../test/r2-memory'

const BASE = 'https://api.test/media/u/'

describe('photo media', () => {
  it('derives hero, hover, thumb and gallery from the order of names, and reads the order back', () => {
    const media = JSON.parse(mediaFor(BASE, 'mch_a', 'prd_b', ['ph_1', 'ph_2']))
    expect(media).toEqual({
      heroImage: `${BASE}products/mch_a/prd_b/ph_1-1600.webp`,
      hoverImage: `${BASE}products/mch_a/prd_b/ph_2-1600.webp`,
      thumb: `${BASE}products/mch_a/prd_b/ph_1-400.webp`,
      gallery: [`${BASE}products/mch_a/prd_b/ph_1-1600.webp`, `${BASE}products/mch_a/prd_b/ph_2-1600.webp`],
    })
    expect(namesIn(JSON.stringify(media), BASE, 'mch_a', 'prd_b')).toEqual(['ph_1', 'ph_2'])
    expect(mediaFor(BASE, 'mch_a', 'prd_b', [])).toBe('{}')
    expect(namesIn('{}', BASE, 'mch_a', 'prd_b')).toEqual([])
  })

  it("refuses to read media it did not mint, or another product's", () => {
    const curated = JSON.stringify({ gallery: ['/media/products/wh1000xm6-1.webp'] })
    expect(namesIn(curated, BASE, 'mch_a', 'prd_b')).toBeNull()
    const elsewhere = mediaFor(BASE, 'mch_a', 'prd_OTHER', ['ph_1'])
    expect(namesIn(elsewhere, BASE, 'mch_a', 'prd_b')).toBeNull()
  })

  it('knows webp by its bytes', () => {
    expect(isWebp(webpBytes())).toBe(true)
    expect(isWebp(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(false)
    expect(isWebp(new Uint8Array(4))).toBe(false)
  })

  it('accepts only the keys it mints', () => {
    expect(isPhotoKey(keyFor('mch_a1', 'prd_b2', 'ph_c3', 1600))).toBe(true)
    expect(isPhotoKey('products/mch_a/prd_b/../../secret')).toBe(false)
    expect(isPhotoKey('backups/db.sql')).toBe(false)
  })
})

describe('GET /media/u/*', () => {
  const get = (env: Partial<Env>, key: string) =>
    worker.fetch(new Request(`https://api.test/media/u/${key}`), env as Env)

  it('serves a stored photo as an immutable webp', async () => {
    const r2 = memoryR2()
    const key = keyFor('mch_a', 'prd_b', 'ph_c', 1600)
    await r2.bucket.put(key, webpBytes().buffer as ArrayBuffer)
    const res = await get({ MEDIA: r2.bucket }, key)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/webp')
    expect(res.headers.get('cache-control')).toContain('immutable')
    expect(isWebp(new Uint8Array(await res.arrayBuffer()))).toBe(true)
  })

  it('answers 404 for a key it would never mint, without asking the bucket', async () => {
    const r2 = memoryR2()
    await r2.bucket.put('private/notes.txt', new ArrayBuffer(1))
    expect((await get({ MEDIA: r2.bucket }, 'private/notes.txt')).status).toBe(404)
    expect((await get({ MEDIA: r2.bucket }, keyFor('mch_a', 'prd_b', 'ph_missing', 400))).status).toBe(404)
  })
})
