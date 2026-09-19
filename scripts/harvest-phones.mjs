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
const CREDITS = 'src/data/credits.json'

/**
 * Records where a vendor image came from.
 *
 * Commons and Unsplash images are licensed for reuse and their credit lines are
 * a licence obligation. A manufacturer's product render is not licensed to us at
 * all; it is used here for a non-commercial portfolio build. Recording the exact
 * source URL and the date it was fetched is what keeps that defensible and
 * reversible — any single image can be traced to its origin and pulled without
 * touching the rest of the catalogue.
 */
function recordCredit(destPath, sourceUrl, vendor) {
  const credits = JSON.parse(fs.readFileSync(CREDITS, 'utf8'))
  const file = destPath.replace(/\\/g, '/').replace(/^public\//, '')
  const entry = {
    file,
    photographer: vendor,
    profileUrl: new URL(sourceUrl).origin,
    sourceUrl,
    source: new URL(sourceUrl).host,
    licence: `© ${vendor}, official product image — demonstration use, retrieved ${new Date()
      .toISOString()
      .slice(0, 10)}`,
  }
  const i = credits.findIndex((c) => c.file === file)
  if (i === -1) credits.push(entry)
  else credits[i] = entry
  fs.writeFileSync(CREDITS, JSON.stringify(credits, null, 2) + '\n')
}

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

const VENDOR_OF = {
  'pixel-11-pro': 'Google',
  'xiaomi-17-ultra': 'Xiaomi',
  'galaxy-s26-ultra': 'Samsung',
  'oneplus-15': 'OnePlus',
}

for (const job of JOBS) {
  const before = compactGallery(job.slug)
  try {
    // Re-running is cheap and idempotent: existing files are kept, and the walk
    // still reports the URL each slot came from, which is what the credit needs.
    const r = await harvest(job.page, job.slug, OUT, 4, job.keywords, job.sizeSuffix)
    const after = compactGallery(job.slug)
    console.log(`  ${job.slug.padEnd(20)} ${r.candidates} candidates -> ${after}/4${before === after ? ' (unchanged)' : ''}`)
    for (const s of r.saved) {
      if (fs.existsSync(s.dest)) recordCredit(s.dest, s.url, VENDOR_OF[job.slug] ?? 'Manufacturer')
      if (s.source) console.log(`      ${String(s.source).padEnd(11)} ${s.url.slice(0, 92)}`)
    }
  } catch (e) {
    console.log(`  ${job.slug.padEnd(20)} FAILED: ${e.message}`)
  }
}

/**
 * Apple resolves from its store CDN by constructed id rather than by scraping,
 * because its marketing pages carry key art rather than product renders. The id
 * encodes model, launch month, screen size and finish, and the CDN honours an
 * arbitrary `wid`, so every finish comes back at the same size and framing.
 */
const APPLE_CDN = 'https://store.storeimages.cdn-apple.com/1/as-images.apple.com/is'
const APPLE_FINISHES = ['burgundy', 'black', 'silver', 'glacier']

for (const [slug, size] of [
  ['iphone-18-pro', '6-3inch'],
  ['iphone-18-pro-max', '6-9inch'],
]) {
  for (let i = 0; i < APPLE_FINISHES.length; i++) {
    const url = `${APPLE_CDN}/iphone-18-pro-finish-select-202609-${size}-${APPLE_FINISHES[i]}?wid=2000&hei=2000&fmt=png-alpha`
    const dest = path.join(OUT, `${slug}-${i + 1}.webp`)
    try {
      if (!fs.existsSync(dest)) await saveImage(url, dest, 1600)
      recordCredit(dest, url, 'Apple')
    } catch (e) {
      console.log(`  ${slug}-${i + 1} FAILED: ${e.message}`)
    }
  }
  console.log(`  ${slug.padEnd(20)} ${compactGallery(slug)}/4 (Apple store CDN)`)
}

console.log('\nthumbnails:')
for (const slug of [...JOBS.map((j) => j.slug), 'iphone-18-pro', 'iphone-18-pro-max']) {
  console.log(`  ${slug.padEnd(20)} ${(await writeThumb(slug)) ? 'written' : 'skipped'}`)
}

export { saveImage }
