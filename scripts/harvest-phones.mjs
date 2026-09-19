/**
 * Fills the phones slice: tier-1 harvest, gap renumbering and thumbnails.
 *
 * Run with `node scripts/harvest-phones.mjs`. Existing files are left alone, so
 * it is safe to re-run after deleting whichever images failed an eye check.
 */
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { harvest, saveImage } from './fetch-vendor-images.mjs'

const OUT = 'public/media/products'

const JOBS = [
  {
    slug: 'pixel-11-pro',
    page: 'https://store.google.com/product/pixel_11_pro',
    // Google's opaque ids carry no product name, so keyword ranking has nothing
    // to bite on; the size suffix is what makes them usable at all.
    keywords: ['pixel'],
    sizeSuffix: '=w2000',
  },
  {
    // mi.com global returns its 404 page for xiaomi-17-pro: that model is sold
    // in China only. The global flagship is the 17 Ultra, so that is what this
    // storefront lists.
    slug: 'xiaomi-17-ultra',
    page: 'https://www.mi.com/global/product/xiaomi-17-ultra/',
    keywords: ['17-ultra', 'xiaomi-17', 'ultra'],
  },
  {
    slug: 'galaxy-s26-ultra',
    page: 'https://www.samsung.com/us/smartphones/galaxy-s26-ultra/buy/',
    keywords: ['galaxy-s26-ultra', 's26-ultra', 'sm-s93'],
  },
  {
    slug: 'oneplus-15',
    page: 'https://www.oneplus.com/us/oneplus-15',
    keywords: ['oneplus-15', 'oneplus15'],
  },
]

/** Closes holes left by images removed in review, so `-1` always exists. */
function compactGallery(slug) {
  const present = [1, 2, 3, 4]
    .map((n) => path.join(OUT, `${slug}-${n}.webp`))
    .filter((f) => fs.existsSync(f))
  present.forEach((src, i) => {
    const want = path.join(OUT, `${slug}-${i + 1}.webp`)
    if (src !== want) fs.renameSync(src, want)
  })
  return present.length
}

/**
 * The thumbnail is derived from the hero rather than fetched separately. When
 * they were sourced independently a product could show one photograph on the
 * card and a different one on its page; deriving makes that impossible.
 */
async function writeThumb(slug) {
  const hero = path.join(OUT, `${slug}-1.webp`)
  const thumb = path.join(OUT, `${slug}-thumb.webp`)
  if (!fs.existsSync(hero) || fs.existsSync(thumb)) return false
  await sharp(hero).resize({ width: 600, withoutEnlargement: true }).webp({ quality: 80 }).toFile(thumb)
  return true
}

for (const job of JOBS) {
  const before = compactGallery(job.slug)
  if (before >= 4) {
    console.log(`  ${job.slug.padEnd(20)} already complete (${before})`)
    continue
  }
  try {
    const r = await harvest(job.page, job.slug, OUT, 4, job.keywords, job.sizeSuffix)
    const after = compactGallery(job.slug)
    console.log(`  ${job.slug.padEnd(20)} ${r.candidates} candidates -> ${after}/4`)
    for (const s of r.saved) if (s.source) console.log(`      ${String(s.source).padEnd(11)} ${s.url.slice(0, 92)}`)
  } catch (e) {
    console.log(`  ${job.slug.padEnd(20)} FAILED: ${e.message}`)
  }
}

console.log('\nthumbnails:')
for (const slug of [...JOBS.map((j) => j.slug), 'iphone-18-pro', 'iphone-18-pro-max']) {
  console.log(`  ${slug.padEnd(20)} ${(await writeThumb(slug)) ? 'written' : 'skipped'}`)
}

export { saveImage }
