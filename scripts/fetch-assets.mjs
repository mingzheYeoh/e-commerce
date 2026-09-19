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
  // audio
  { slug: 'op1-field', query: 'synthesizer knobs dark studio' },
  { slug: 'wh1000xm6', query: 'headphones dark background' },
  { slug: 'ear-open', query: 'wireless earbuds dark' },
  { slug: 'monitor-one', query: 'studio monitor speaker dark' },
  // peripherals
  { slug: 'q3-max', query: 'mechanical keyboard rgb dark' },
  { slug: 'switch-set', query: 'keyboard switches macro' },
  { slug: 'glyph-mouse', query: 'computer mouse dark desk' },
  { slug: 'deck-pro', query: 'audio mixer console dark' },
  // imaging
  { slug: 'mavic-4-pro', query: 'drone dark background' },
  { slug: 'osmo-7', query: 'camera gimbal stabilizer' },
  { slug: 'alpha-7cr', query: 'mirrorless camera dark' },
  { slug: 'matrice-350', query: 'professional drone flying sky' },
  // computing
  { slug: 'xr-spatial', query: 'vr headset dark' },
  { slug: 'phone-3a', query: 'smartphone dark minimal' },
  { slug: 'ring-one', query: 'smartwatch dark minimal' },
  { slug: 'tp7-recorder', query: 'field recorder audio device' },
]

/** Brand hover previews: <id>.webp */
const BRANDS = [
  { slug: 'teenage-engineering', query: 'synthesizer module studio' },
  { slug: 'nothing', query: 'transparent electronics minimal' },
  { slug: 'dji', query: 'drone camera technology' },
  { slug: 'sony', query: 'professional camera lens dark' },
  { slug: 'keychron', query: 'custom keyboard keycaps' },
  { slug: 'kinetic', query: 'circuit board macro dark' },
]

/** Category bento cards: <id>.webp */
const CATEGORIES = [
  { slug: 'audio', query: 'recording studio mixing desk dark' },
  { slug: 'peripherals', query: 'mechanical keyboard backlit dark' },
  { slug: 'imaging', query: 'drone aerial camera technology' },
  { slug: 'computing', query: 'augmented reality glasses technology' },
]

/** Module 4 hero product, shot large */
const FLAGSHIP = [{ slug: 'flagship', query: 'headphones product studio black' }]

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
  const results = await searchUnsplash(job.query)
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
