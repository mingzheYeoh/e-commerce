#!/usr/bin/env node
/**
 * Asset pipeline for NEXUS // TECH COLLECTIVE.
 *
 * Downloads real, licensed photography and video into public/media/ so the site
 * never hotlinks a third-party CDN. (The video URLs in the original spec are
 * dead: assets.mixkit.co returns 403 hotlink-blocked, cdn.coverr.co 404s.)
 *
 *   npm run assets
 *
 * Properties:
 *   - idempotent : existing output files are skipped, so re-running is cheap
 *   - fail-soft  : any single asset failing logs SKIP and the run still exits 0
 *   - reproducible: the job tables below are the source of truth; edit a query,
 *                   delete the file it produced, re-run to re-pick the photo
 *
 * ffmpeg is optional and only used to transcode/poster the hero video. Without
 * it the source mp4 is copied through unchanged.
 */

import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import sharp from 'sharp'

const execFileAsync = promisify(execFile)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MEDIA = path.join(ROOT, 'public', 'media')

const WIDTH_MAIN = 1600
const WIDTH_THUMB = 400
const QUALITY = 82

/* ------------------------------------------------------------------ *
 * Job tables
 * ------------------------------------------------------------------ */

/** Products: each produces <slug>-main.webp, <slug>-alt.webp, <slug>-thumb.webp */
const PRODUCTS = [
  // Apple
  { slug: 'airpods-max', query: 'over ear headphones silver', must: ['headphone'] },
  { slug: 'macbook-pro', query: 'macbook laptop dark desk', must: ['laptop', 'macbook', 'computer'] },
  { slug: 'watch-ultra', query: 'smartwatch titanium close up', must: ['watch'] },
  // Samsung
  { slug: 'galaxy-s26', query: 'android smartphone dark', must: ['phone'] },
  { slug: 'galaxy-buds', query: 'wireless earbuds charging case', must: ['earbud', 'earphone', 'airpod'] },
  { slug: 'odyssey-oled', query: 'ultrawide gaming monitor desk', must: ['monitor', 'screen', 'display'] },
  // Sony
  { slug: 'wh1000xm6', query: 'black headphones product', must: ['headphone'] },
  { slug: 'alpha-7cr', query: 'mirrorless camera black background', must: ['mirrorless', 'sony', 'camera body'] },
  { slug: 'fx3-cinema', query: 'cinema camera rig video', must: ['camera'] },
  // Bose
  { slug: 'qc-ultra', query: 'noise cancelling headphones dark', must: ['headphone'] },
  { slug: 'open-earbuds', query: 'earbuds macro dark', must: ['earbud', 'earphone'] },
  { slug: 'soundlink-max', query: 'portable bluetooth speaker', must: ['speaker'] },
  // Sennheiser
  { slug: 'hd900s', query: 'studio headphones open back', must: ['headphone'] },
  { slug: 'momentum-4', query: 'wireless headphones desk', must: ['headphone'] },
  // DJI
  { slug: 'mavic-4-pro', query: 'drone quadcopter close up', must: ['drone', 'quadcopter'] },
  { slug: 'osmo-pocket', query: 'handheld gimbal camera', must: ['camera', 'gimbal'] },
  { slug: 'rs4-gimbal', query: 'camera gimbal stabilizer', must: ['gimbal', 'camera'] },
  // Logitech
  { slug: 'mx-master', query: 'wireless mouse dark desk', must: ['mouse'] },
  { slug: 'mx-mechanical', query: 'low profile keyboard desk', must: ['keyboard'] },
  { slug: 'brio-webcam', query: 'webcam camera monitor', must: ['webcam', 'camera'] },
  // Razer
  { slug: 'blackwidow', query: 'gaming keyboard rgb dark', must: ['keyboard'] },
  { slug: 'viper-v3', query: 'gaming mouse rgb', must: ['mouse'] },
  { slug: 'blade-16', query: 'gaming laptop rgb dark', must: ['laptop', 'computer'] },
  // Anker
  { slug: 'prime-powerbank', query: 'power bank portable charger', must: ['power bank', 'charger', 'battery'] },
  { slug: 'soundcore-liberty', query: 'earbuds case product dark', must: ['earbud', 'earphone'] },
  { slug: 'gan-charger', query: 'usb charger adapter cable', must: ['charger', 'adapter', 'cable', 'usb'] },
  // Nothing
  { slug: 'phone-3a', query: 'smartphone dark minimal', must: ['phone'] },
  { slug: 'ear-open', query: 'wireless earbuds charging case', must: ['earbud', 'airpod', 'earphone'] },
  { slug: 'cmf-buds', query: 'earbuds product photography', must: ['earbud', 'earphone'] },
  // Keychron
  { slug: 'q3-max', query: 'mechanical keyboard rgb dark', must: ['keyboard'] },
  { slug: 'switch-set', query: 'keyboard switches macro', must: ['keyboard', 'key'] },
  { slug: 'k-pro-mouse', query: 'computer mouse minimal dark', must: ['mouse'] },
  // Teenage Engineering
  { slug: 'op1-field', query: 'synthesizer close up knobs', must: ['synth', 'keyboard', 'knob'] },
  { slug: 'tp7-recorder', query: 'portable audio recorder microphone', must: ['recorder', 'microphone', 'audio'] },
  { slug: 'ob4-speaker', query: 'speaker audio black', must: ['speaker'] },
]

/** Brand hover previews: <id>.webp */
const BRANDS = [
  { slug: 'apple', query: 'apple products desk minimal' },
  { slug: 'samsung', query: 'smartphone display technology' },
  { slug: 'sony', query: 'professional camera lens dark' },
  { slug: 'bose', query: 'headphones minimal product' },
  { slug: 'sennheiser', query: 'studio headphones microphone' },
  { slug: 'dji', query: 'drone camera technology' },
  { slug: 'logitech', query: 'desk setup mouse keyboard' },
  { slug: 'razer', query: 'gaming setup rgb dark' },
  { slug: 'anker', query: 'charging cables usb technology' },
  { slug: 'nothing', query: 'transparent electronics minimal' },
  { slug: 'keychron', query: 'custom keyboard keycaps' },
  { slug: 'teenage-engineering', query: 'synthesizer module studio' },
]

/** Category bento cards: <id>.webp */
const CATEGORIES = [
  { slug: 'audio', query: 'recording studio mixing desk dark' },
  { slug: 'peripherals', query: 'mechanical keyboard backlit dark' },
  { slug: 'imaging', query: 'drone aerial camera technology' },
  { slug: 'computing', query: 'augmented reality glasses technology' },
]

/** Module 4 hero product, shot large */
const FLAGSHIP = [
  {
    slug: 'flagship',
    query: 'studio headphones black background',
    must: ['headphone'],
    // The one image a visitor has to read in detail. Neither the darkest
    // candidate (unreadable) nor the brightest (warm lifestyle shots that fight
    // the palette) — aim for a mid-dark frame.
    targetLuma: 30,
  },
]

/**
 * Hero backdrop video. ID verified reachable and visually checked (cyan node
 * mesh on near-black — grades cleanly against accent-cyan).
 * Pexels video file URLs carry a resolution suffix that varies per upload, so
 * the suffix list is probed in order rather than assumed.
 */
const HERO_VIDEO = {
  id: '3129671',
  name: 'hero-grid',
  suffixes: [
    'hd_1920_1080_30fps',
    'hd_1920_1080_25fps',
    'hd_1280_720_30fps',
    'hd_1280_720_25fps',
  ],
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const credits = []
let skipped = 0

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
}

/**
 * Unsplash's public search endpoint. No API key required.
 * Returns results sorted by likes, highest first.
 */
async function searchUnsplash(query) {
  const url = `https://unsplash.com/napi/search/photos?query=${encodeURIComponent(
    query,
  )}&per_page=24&orientation=landscape`
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'nexus-asset-pipeline' },
  })
  if (!res.ok) throw new Error(`unsplash search ${res.status}`)
  const json = await res.json()
  const results = (json.results ?? []).filter((r) => r?.urls?.raw)
  if (!results.length) throw new Error('no results')
  return results.sort((a, b) => (b.likes ?? 0) - (a.likes ?? 0))
}

/**
 * Sorting by likes alone is biased toward artistry over subject: the most-liked
 * "drone" photo on Unsplash is an aerial landscape, and the most-liked
 * "synthesizer" is a studio mood shot. When a job declares `must` keywords, keep
 * only results whose caption actually names the object, then rank those by
 * likes. Falls back to the unfiltered list if nothing matches.
 */
function preferSubject(results, must) {
  if (!must?.length) return results
  const hit = results.filter((r) => {
    const text = `${r.alt_description ?? ''} ${r.description ?? ''}`.toLowerCase()
    return must.some((word) => text.includes(word))
  })
  return hit.length >= 2 ? hit : results
}

/**
 * The site's base is #050505, so a photo on a bright background reads as a hole
 * punched in the page no matter how good it is. Probe the thumbnails of the
 * strongest candidates and rank them darkest-first.
 *
 * Unsplash exposes an average colour per photo, but it is unreliable for
 * product shots on seamless backdrops, so this measures the actual pixels.
 */
async function rankByLuma(results, target = null, sampleSize = 8) {
  const candidates = results.slice(0, sampleSize)
  const scored = await Promise.all(
    candidates.map(async (photo) => {
      try {
        const buf = await fetchBuffer(`${photo.urls.raw}&w=200&q=60&fm=jpg&fit=max`)
        const { channels } = await sharp(buf).stats()
        // Rec. 709 luma over the per-channel means
        const luma =
          0.2126 * channels[0].mean + 0.7152 * channels[1].mean + 0.0722 * channels[2].mean
        return { photo, luma }
      } catch {
        return { photo, luma: 255 } // unmeasurable sorts last
      }
    }),
  )
  // target === null: darkest first, for atmosphere.
  // target set: closest to that luma first — dark enough to belong on #050505,
  // bright enough that the subject is still readable.
  scored.sort((a, b) =>
    target === null ? a.luma - b.luma : Math.abs(a.luma - target) - Math.abs(b.luma - target),
  )
  return [...scored.map((s) => s.photo), ...results.slice(sampleSize)]
}

async function fetchBuffer(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'nexus-asset-pipeline' } })
  if (!res.ok) throw new Error(`download ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

/** Download one Unsplash photo and write it as WebP at the given width. */
async function writePhoto(photo, dest, width) {
  if (existsSync(dest)) return false
  const buf = await fetchBuffer(`${photo.urls.raw}&w=2400&q=90&fm=jpg&fit=max`)
  await sharp(buf).resize({ width, withoutEnlargement: true }).webp({ quality: QUALITY }).toFile(dest)
  return true
}

function credit(file, photo) {
  credits.push({
    file,
    photographer: photo.user?.name ?? 'Unknown',
    profileUrl: photo.user?.links?.html ?? 'https://unsplash.com',
    sourceUrl: photo.links?.html ?? 'https://unsplash.com',
    source: 'Unsplash',
  })
}

/**
 * Runs one image job. `variants` maps a filename suffix to a result index and
 * width, so a product gets main/alt from two different photos of the same query.
 */
async function runImageJob(job, dir, variants) {
  const targets = variants.map((v) => path.join(dir, `${job.slug}${v.suffix}.webp`))
  if (targets.every((t) => existsSync(t))) {
    process.stdout.write(`  = ${job.slug} (cached)\n`)
    return
  }
  const results = await rankByLuma(preferSubject(await searchUnsplash(job.query), job.must), job.targetLuma ?? null)
  for (const v of variants) {
    const photo = results[v.index] ?? results[0]
    const dest = path.join(dir, `${job.slug}${v.suffix}.webp`)
    const wrote = await writePhoto(photo, dest, v.width)
    if (wrote) credit(path.relative(path.join(ROOT, 'public'), dest).replace(/\\/g, '/'), photo)
  }
  process.stdout.write(`  + ${job.slug}\n`)
}

async function runBatch(label, jobs, dir, variants) {
  await ensureDir(dir)
  process.stdout.write(`\n${label}\n`)
  for (const job of jobs) {
    try {
      await runImageJob(job, dir, variants)
    } catch (err) {
      skipped++
      process.stdout.write(`  SKIP ${job.slug}: ${err.message}\n`)
    }
  }
}

async function hasFfmpeg() {
  try {
    await execFileAsync('ffmpeg', ['-version'])
    return true
  } catch {
    return false
  }
}

/** Download the hero clip, transcode it down for web, and cut a poster frame. */
async function runVideo() {
  const dir = path.join(MEDIA, 'video')
  await ensureDir(dir)
  const out = path.join(dir, `${HERO_VIDEO.name}.mp4`)
  const poster = path.join(dir, `${HERO_VIDEO.name}-poster.webp`)
  process.stdout.write('\nvideo\n')

  if (existsSync(out) && existsSync(poster)) {
    process.stdout.write(`  = ${HERO_VIDEO.name} (cached)\n`)
    return
  }

  let source = null
  for (const suffix of HERO_VIDEO.suffixes) {
    const url = `https://videos.pexels.com/video-files/${HERO_VIDEO.id}/${HERO_VIDEO.id}-${suffix}.mp4`
    try {
      const res = await fetch(url, { headers: { Range: 'bytes=0-1000' } })
      if (res.ok || res.status === 206) {
        source = url
        break
      }
    } catch {
      /* try the next suffix */
    }
  }
  if (!source) {
    skipped++
    process.stdout.write('  SKIP hero video: no reachable source URL\n')
    return
  }

  const raw = path.join(dir, `${HERO_VIDEO.name}.src.mp4`)
  await fs.writeFile(raw, await fetchBuffer(source))

  if (await hasFfmpeg()) {
    // 720p, no audio track, CRF 30 — it sits behind a 60%-opacity grade and a
    // scanline layer, so detail here is invisible but bytes are not.
    await execFileAsync('ffmpeg', [
      '-y', '-loglevel', 'error', '-i', raw,
      '-vf', 'scale=1280:-2', '-an',
      '-c:v', 'libx264', '-crf', '30', '-preset', 'slow',
      '-movflags', '+faststart', out,
    ])
    await execFileAsync('ffmpeg', [
      '-y', '-loglevel', 'error', '-ss', '2', '-i', out,
      '-frames:v', '1', '-vf', 'scale=1280:-2', path.join(dir, 'poster.png'),
    ])
    await sharp(path.join(dir, 'poster.png')).webp({ quality: QUALITY }).toFile(poster)
    await fs.rm(path.join(dir, 'poster.png'), { force: true })
    await fs.rm(raw, { force: true })
  } else {
    await fs.rename(raw, out)
    process.stdout.write('  ! ffmpeg not found: video copied untranscoded, no poster\n')
  }

  credits.push({
    file: `media/video/${HERO_VIDEO.name}.mp4`,
    photographer: 'Pexels contributor',
    profileUrl: `https://www.pexels.com/video/${HERO_VIDEO.id}/`,
    sourceUrl: `https://www.pexels.com/video/${HERO_VIDEO.id}/`,
    source: 'Pexels',
  })
  process.stdout.write(`  + ${HERO_VIDEO.name}\n`)
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main() {
  process.stdout.write('NEXUS asset pipeline\n====================\n')

  await runBatch('products', PRODUCTS, path.join(MEDIA, 'products'), [
    { suffix: '-main', index: 0, width: WIDTH_MAIN },
    { suffix: '-alt', index: 1, width: WIDTH_MAIN },
    { suffix: '-thumb', index: 0, width: WIDTH_THUMB },
  ])

  await runBatch('brands', BRANDS, path.join(MEDIA, 'brands'), [
    { suffix: '', index: 0, width: 800 },
  ])

  await runBatch('categories', CATEGORIES, path.join(MEDIA, 'categories'), [
    { suffix: '', index: 0, width: WIDTH_MAIN },
  ])

  await runBatch('flagship', FLAGSHIP, path.join(MEDIA, 'flagship'), [
    { suffix: '', index: 0, width: 2000 },
  ])

  await runVideo()

  // Merge with any credits from a previous partial run so cached assets keep
  // their attribution.
  const creditsPath = path.join(ROOT, 'src', 'data', 'credits.json')
  let existing = []
  try {
    existing = JSON.parse(await fs.readFile(creditsPath, 'utf8'))
  } catch {
    /* first run */
  }
  const byFile = new Map(existing.map((c) => [c.file, c]))
  for (const c of credits) byFile.set(c.file, c)
  await ensureDir(path.dirname(creditsPath))
  await fs.writeFile(
    creditsPath,
    JSON.stringify([...byFile.values()].sort((a, b) => a.file.localeCompare(b.file)), null, 2) + '\n',
  )

  process.stdout.write(
    `\ndone. ${byFile.size} assets credited, ${skipped} skipped.\n` +
      `credits -> src/data/credits.json\n`,
  )
}

main().catch((err) => {
  // Never fail the build over assets; the UI degrades to CSS placeholders.
  process.stderr.write(`asset pipeline error: ${err.message}\n`)
  process.exit(0)
})
