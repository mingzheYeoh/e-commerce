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
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
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
  // Laptops. Tier 1 cannot reach these: see scripts/harvest-vendor.mjs.
  { slug: 'xps-16', query: 'dell xps laptop open desk', wiki: 'Dell XPS 15', must: ['laptop', 'notebook', 'computer'], allowBrands: ['dell', 'xps', 'alienware'] },
  { slug: 'thinkpad-x1-carbon', query: 'thinkpad laptop black', wiki: 'ThinkPad X1 Carbon', must: ['thinkpad', 'laptop'], allowBrands: ['lenovo', 'thinkpad', 'ibm'] },
  { slug: 'zenbook-s14', query: 'asus zenbook thin laptop', wiki: 'Asus Zenbook', must: ['laptop', 'zenbook', 'notebook'], allowBrands: ['asus', 'zenbook'] },
  { slug: 'zenbook-duo', query: 'dual screen laptop two displays', wiki: 'Asus Zenbook Duo', must: ['laptop', 'dual', 'zenbook'], allowBrands: ['asus', 'zenbook'] },
  // Phones. Xiaomi is here rather than in the vendor harvester because mi.com
  // ships only art-directed marketing imagery -- see scripts/rejected-images.json.
  // Apple
  { slug: 'airpods-max', query: 'apple airpods max headphones', wiki: 'AirPods Max', must: ['headphone'], allowBrands: ['apple', 'airpod'] },
  { slug: 'macbook-pro', query: 'macbook laptop dark desk', wiki: 'MacBook Pro 16', must: ['laptop', 'macbook', 'computer'] },
  { slug: 'watch-ultra', query: 'smartwatch titanium close up', wiki: 'Apple Watch Ultra', must: ['watch'] },
  // Samsung
  { slug: 'galaxy-s26', query: 'samsung galaxy phone', wiki: 'Samsung Galaxy S24 Ultra', must: ['phone'], allowBrands: ['samsung', 'galaxy'] },
  { slug: 'galaxy-buds', query: 'samsung galaxy buds earbuds', wiki: 'Samsung Galaxy Buds', must: ['earbud', 'earphone', 'bud'], allowBrands: ['samsung', 'galaxy'] },
  { slug: 'odyssey-oled', query: 'ultrawide gaming monitor desk', wiki: 'Samsung Odyssey monitor', must: ['monitor', 'screen', 'display'] },
  // Sony
  { slug: 'wh1000xm6', query: 'sony wireless headphones', wiki: 'Sony WH-1000XM', must: ['headphone'], allowBrands: ['sony'] },
  { slug: 'alpha-7cr', query: 'mirrorless camera black background', wiki: 'Sony Alpha 7', must: ['mirrorless', 'sony', 'camera body'] },
  { slug: 'fx3-cinema', query: 'cinema camera rig video', wiki: 'Sony FX3 camera', must: ['camera'] },
  // Bose
  { slug: 'qc-ultra', query: 'noise cancelling headphones dark', wiki: 'Bose QuietComfort', must: ['headphone'] },
  { slug: 'open-earbuds', query: 'earbuds macro dark', wiki: 'Bose earbuds', must: ['earbud', 'earphone'] },
  { slug: 'soundlink-max', query: 'bose portable speaker', wiki: 'Bose SoundLink speaker', must: ['speaker'], allowBrands: ['bose'] },
  // Sennheiser
  { slug: 'hd900s', query: 'sennheiser studio headphones', wiki: 'Sennheiser HD headphones', must: ['headphone'], allowBrands: ['sennheiser'] },
  { slug: 'momentum-4', query: 'sennheiser momentum headphones', wiki: 'Sennheiser Momentum', must: ['headphone'], allowBrands: ['sennheiser'] },
  // DJI
  { slug: 'mavic-4-pro', query: 'drone quadcopter close up', wiki: 'DJI Mavic 4 Pro', must: ['drone', 'quadcopter'] },
  { slug: 'osmo-pocket', query: 'pocket action camera handheld', wiki: 'DJI Osmo Pocket', must: ['camera'] },
  { slug: 'rs4-gimbal', query: 'dji gimbal stabilizer rig', wiki: 'DJI Ronin gimbal', must: ['gimbal'], allowBrands: ['dji'] },
  // Logitech
  { slug: 'mx-master', query: 'logitech wireless mouse', wiki: 'Logitech MX Master', must: ['mouse'], allowBrands: ['logitech'] },
  { slug: 'mx-mechanical', query: 'low profile keyboard desk', wiki: 'Logitech keyboard', must: ['keyboard'] },
  { slug: 'brio-webcam', query: 'webcam camera monitor', wiki: 'Logitech webcam', must: ['webcam', 'camera'] },
  // Razer
  { slug: 'blackwidow', query: 'gaming keyboard rgb dark', wiki: 'Razer BlackWidow keyboard', must: ['keyboard'] },
  { slug: 'viper-v3', query: 'gaming mouse rgb', wiki: 'Razer mouse', must: ['mouse'] },
  { slug: 'blade-16', query: 'gaming laptop rgb dark', wiki: 'Razer Blade laptop', must: ['laptop', 'computer'] },
  // Anker
  { slug: 'prime-powerbank', query: 'power bank portable charger', wiki: 'Anker power bank', must: ['power bank', 'charger', 'battery'] },
  { slug: 'soundcore-liberty', query: 'earbuds case product dark', wiki: 'Anker Soundcore earbuds', must: ['earbud', 'earphone'] },
  { slug: 'gan-charger', query: 'usb c charger plug dark', wiki: 'USB charger', must: ['charger', 'adapter', 'plug'] },
  // Nothing
  { slug: 'phone-3a', query: 'smartphone product photography', wiki: 'Nothing Phone (2)', must: ['phone', 'smartphone'], allowBrands: ['nothing'], targetLuma: 45 },
  { slug: 'ear-open', query: 'wireless earbuds charging case', wiki: 'Nothing Ear', must: ['earbud', 'airpod', 'earphone'] },
  { slug: 'cmf-buds', query: 'wireless earbuds white background', wiki: 'wireless earbuds', must: ['earbud', 'earphone', 'bud'] },
  // Keychron
  { slug: 'q3-max', query: 'mechanical keyboard rgb dark', wiki: 'Keychron keyboard', must: ['keyboard'] },
  { slug: 'switch-set', query: 'keyboard switches macro', wiki: 'mechanical keyboard switches', must: ['keyboard', 'key'] },
  { slug: 'k-pro-mouse', query: 'computer mouse minimal dark', wiki: 'Keychron mouse', must: ['mouse'] },
  // Teenage Engineering
  { slug: 'op1-field', query: 'synthesizer close up knobs', wiki: 'Teenage Engineering OP-1', must: ['synth', 'keyboard', 'knob'] },
  { slug: 'tp7-recorder', query: 'portable audio recorder microphone', wiki: 'Teenage Engineering TP-7', must: ['recorder', 'microphone', 'audio'] },
  { slug: 'ob4-speaker', query: 'bluetooth speaker product studio', wiki: 'portable speaker', must: ['speaker'] },
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

/**
 * md5 of every image already written, seeded from disk at startup. Two jobs with
 * similar queries otherwise converge on the same top-ranked photo, and a
 * catalogue showing one picture under two product names reads as broken.
 */
const seenHashes = new Set()

function seedHashesFrom(dir) {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) seedHashesFrom(p)
    else if (p.endsWith('.webp')) seenHashes.add(createHash('md5').update(readFileSync(p)).digest('hex'))
  }
}

/**
 * Captions that name a brand we are not selling under this slug get dropped.
 * This only catches what the caption says — a logo visible in the pixels but
 * absent from the text still gets through, which is why the generated sheet
 * has to be looked at by a human before shipping.
 */
const BRAND_WORDS = [
  'apple', 'airpod', 'iphone', 'ipad', 'macbook', 'imac', 'samsung', 'galaxy',
  'sony', 'bose', 'sennheiser', 'dji', 'logitech', 'razer', 'anker', 'keychron',
  'jbl', 'beats', 'marshall', 'bang olufsen', 'sonos', 'huawei', 'xiaomi',
  'google pixel', 'gopro', 'canon', 'nikon', 'fujifilm', 'panasonic', 'dell',
  'hp ', 'lenovo', 'asus', 'acer', 'microsoft', 'nintendo', 'yamaha', 'jabra',
  'skullcandy', 'audio-technica', 'audio technica', 'akg', 'shure', 'philips',
  'oneplus', 'oppo', 'vivo', 'realme', 'motorola', 'nokia', 'steelseries',
  'corsair', 'hyperx', 'jvc', 'sennheiser', 'bang & olufsen',
]

function rejectsForeignBrands(results, allow = []) {
  const allowed = allow.map((a) => a.toLowerCase())
  const clean = results.filter((r) => {
    const text = `${r.alt_description ?? ''} ${r.description ?? ''}`.toLowerCase()
    const foreign = BRAND_WORDS.filter((w) => text.includes(w) && !allowed.some((a) => w.includes(a) || a.includes(w)))
    return foreign.length === 0
  })
  return clean.length >= 2 ? clean : results
}

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
        const buf = await fetchBuffer(photo.probeUrl ?? photo.downloadUrl)
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

/**
 * Wikimedia Commons: the only source that has photographs of the actual
 * products — a real Mavic 4 Pro, a real Apple Watch Ultra — under a licence
 * that permits reuse. Stock libraries only have lookalikes, and manufacturer
 * press images are licensed for editorial use, not for a storefront.
 *
 * CC BY-SA requires attribution, so licence and author are captured per file
 * and surfaced on the product page.
 */
async function searchCommons(query, limit = 3) {
  const url =
    'https://commons.wikimedia.org/w/api.php?action=query&generator=search' +
    `&gsrsearch=${encodeURIComponent(query + ' filetype:bitmap')}` +
    `&gsrlimit=${limit}&gsrnamespace=6&prop=imageinfo&iiprop=url|extmetadata` +
    '&iiurlwidth=2000&format=json'

  const res = await fetch(url, {
    headers: { 'User-Agent': 'nexus-asset-pipeline/1.0 (portfolio demo)' },
  })
  if (!res.ok) throw new Error(`commons ${res.status}`)

  const pages = Object.values((await res.json()).query?.pages ?? {})
  const strip = (html) => (html ?? '').replace(/<[^>]*>/g, '').trim()

  return pages
    .map((p) => {
      const info = p.imageinfo?.[0]
      if (!info?.thumburl) return null
      const meta = info.extmetadata ?? {}
      const licence = strip(meta.LicenseShortName?.value)
      // Anything without a clearly reusable licence is dropped rather than guessed at.
      if (!/^(CC|Public domain|CC0)/i.test(licence)) return null
      return {
        source: 'Wikimedia Commons',
        downloadUrl: info.thumburl,
        title: p.title.replace(/^File:/, ''),
        licence,
        artist: strip(meta.Artist?.value) || 'Unknown',
        pageUrl: info.descriptionurl ?? 'https://commons.wikimedia.org',
      }
    })
    .filter(Boolean)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Wikimedia asks clients to identify themselves and to keep request rates
 * reasonable; firing four downloads per product with no gap earns a 429 and a
 * half-empty catalogue. Requests to their hosts are serialised with a delay,
 * and a 429 backs off rather than failing the asset.
 */
let wikimediaGate = Promise.resolve()
const WIKIMEDIA_DELAY_MS = 1200

function isWikimedia(url) {
  return /wikimedia\.org|wikipedia\.org/.test(url)
}

async function fetchBuffer(url, attempt = 0) {
  if (isWikimedia(url)) {
    const wait = wikimediaGate
    let release
    wikimediaGate = new Promise((resolve) => (release = resolve))
    await wait
    setTimeout(release, WIKIMEDIA_DELAY_MS)
  }

  const res = await fetch(url, {
    headers: { 'User-Agent': 'nexus-asset-pipeline/1.0 (portfolio demo; contact via repo)' },
  })

  if (res.status === 429 && attempt < 1) {
    const backoff = 1500 * 2 ** attempt
    process.stdout.write(`  … rate limited, waiting ${backoff}ms\n`)
    await sleep(backoff)
    return fetchBuffer(url, attempt + 1)
  }

  if (!res.ok) throw new Error(`download ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

/** Unsplash results, mapped onto the same shape Commons results use. */
function asCandidates(unsplash) {
  return unsplash.map((p) => ({
    source: 'Unsplash',
    downloadUrl: `${p.urls.raw}&w=2400&q=90&fm=jpg&fit=max`,
    title: p.alt_description ?? 'Product photograph',
    licence: 'Unsplash Licence',
    artist: p.user?.name ?? 'Unknown',
    pageUrl: p.links?.html ?? 'https://unsplash.com',
    probeUrl: `${p.urls.raw}&w=200&q=60&fm=jpg&fit=max`,
  }))
}

/**
 * Download one photo and write it as WebP.
 *
 * Returns false when the encoded bytes match an image already on disk, so the
 * caller can try the next candidate. Hashing the output rather than tracking
 * photo ids is what makes this reliable: ids have to be parsed back out of URLs
 * for assets fetched by earlier runs, and an Unsplash id can itself begin with
 * a dash, which quietly breaks that parsing. The pixels cannot lie.
 */
async function writePhoto(candidate, dest, width) {
  if (existsSync(dest)) return false

  const buf = await fetchBuffer(candidate.downloadUrl)
  const encoded = await sharp(buf)
    .resize({ width, withoutEnlargement: true })
    .webp({ quality: QUALITY })
    .toBuffer()

  const hash = createHash('md5').update(encoded).digest('hex')
  if (seenHashes.has(hash)) return false

  await fs.writeFile(dest, encoded)
  seenHashes.add(hash)
  return true
}

/** Re-encode a photo already claimed by this job at a different width. */
async function writeSized(candidate, dest, width) {
  const buf = await fetchBuffer(candidate.downloadUrl)
  const encoded = await sharp(buf)
    .resize({ width, withoutEnlargement: true })
    .webp({ quality: QUALITY })
    .toBuffer()
  await fs.writeFile(dest, encoded)
  seenHashes.add(createHash('md5').update(encoded).digest('hex'))
}

function credit(file, candidate) {
  credits.push({
    file,
    photographer: candidate.artist,
    profileUrl: candidate.pageUrl,
    sourceUrl: candidate.pageUrl,
    licence: candidate.licence,
    source: candidate.source,
  })
}

/**
 * Runs one image job.
 *
 * Variants are grouped into **slots**: every variant sharing a slot is rendered
 * from the same photograph. That is what keeps a product's 400w thumbnail
 * showing the same picture as its 1600w hero — selecting them independently
 * would let the de-duplication walk land them on different photos, and the cart
 * would then show a thumbnail the product page never displays.
 */
async function runImageJob(job, dir, variants) {
  const targets = variants.map((v) => path.join(dir, `${job.slug}${v.suffix}.webp`))
  if (targets.every((t) => existsSync(t))) {
    process.stdout.write(`  = ${job.slug} (cached)\n`)
    return
  }
  // Commons first: those are photographs of the actual model. Unsplash fills
  // whatever is left, because Commons coverage is uneven — it has a Mavic 4 Pro
  // but nothing for most earbuds.
  let commons = []
  if (job.wiki) {
    try {
      commons = await searchCommons(job.wiki)

      // Commons filenames describe the subject, so the same must-words that
      // filter stock captions apply here too. Without this, "Samsung Odyssey
      // monitor" happily returns a photograph of a building with an Odyssey
      // billboard on the side of it.
      if (job.must?.length) {
        commons = commons.filter((c) =>
          job.must.some((word) => c.title.toLowerCase().includes(word)),
        )
      }

      // Commons filenames name the manufacturer far more reliably than stock
      // captions do, so the brand filter is worth more here, not less.
      commons = commons.filter((c) => {
        const title = c.title.toLowerCase()
        const allowed = (job.allowBrands ?? []).map((a) => a.toLowerCase())
        return !BRAND_WORDS.some(
          (w) => title.includes(w) && !allowed.some((a) => w.includes(a) || a.includes(w)),
        )
      })
    } catch (err) {
      process.stdout.write(`  ~ ${job.slug}: commons unavailable (${err.message})
`)
    }
  }

  const stock = rejectsForeignBrands(
    preferSubject(await searchUnsplash(job.query), job.must),
    job.allowBrands ?? [],
  )
  const results = [...commons, ...(await rankByLuma(asCandidates(stock), job.targetLuma ?? null))]

  if (job.wiki) {
    process.stdout.write(`  · ${job.slug}: ${commons.length} real-product photo(s) from Commons
`)
  }

  /** slot -> the photo chosen for it, resolved once. */
  const chosen = new Map()

  for (const v of variants) {
    const dest = path.join(dir, `${job.slug}${v.suffix}.webp`)
    if (existsSync(dest)) continue

    const settled = chosen.get(v.slot)
    if (settled) {
      // Same photo, different size: bypass the uniqueness walk entirely.
      try {
        await writeSized(settled, dest, v.width)
        continue
      } catch {
        /* fall through and pick a fresh candidate for this file */
      }
    }

    // Walk down the ranking until a candidate yields an image nothing else in
    // the catalogue already uses.
    //
    // A candidate that fails to download drops out and the walk continues. One
    // unreachable file — Commons rate-limits hard after a burst — must not cost
    // the product its photograph when an Unsplash candidate sits right behind
    // it in the same list.
    let picked = null
    for (let i = v.index; i < results.length && !picked; i++) {
      try {
        if (await writePhoto(results[i], dest, v.width)) picked = results[i]
      } catch {
        /* next candidate */
      }
    }

    if (picked) {
      chosen.set(v.slot, picked)
      credit(path.relative(path.join(ROOT, 'public'), dest).replace(/\\/g, '/'), picked)
    } else {
      process.stdout.write(`  ! ${job.slug}${v.suffix}: no unused candidate\n`)
    }
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

  seedHashesFrom(MEDIA)
  process.stdout.write(`images already on disk: ${seenHashes.size}
`)

  await runBatch('products', PRODUCTS, path.join(MEDIA, 'products'), [
    { suffix: '-1', slot: 'a', index: 0, width: WIDTH_MAIN },
    { suffix: '-2', slot: 'b', index: 1, width: WIDTH_MAIN },
    { suffix: '-3', slot: 'c', index: 2, width: WIDTH_MAIN },
    { suffix: '-4', slot: 'd', index: 3, width: WIDTH_MAIN },
    { suffix: '-thumb', slot: 'a', index: 0, width: WIDTH_THUMB },
  ])

  await runBatch('brands', BRANDS, path.join(MEDIA, 'brands'), [
    { suffix: '', slot: 'hero', index: 0, width: 800 },
  ])

  await runBatch('categories', CATEGORIES, path.join(MEDIA, 'categories'), [
    { suffix: '', slot: 'hero', index: 0, width: WIDTH_MAIN },
  ])

  await runBatch('flagship', FLAGSHIP, path.join(MEDIA, 'flagship'), [
    { suffix: '', slot: 'hero', index: 0, width: 2000 },
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

  // A product with no hero image renders a broken card, so the run says so
  // plainly rather than leaving it to be found in the browser.
  const incomplete = PRODUCTS.filter(
    (job) =>
      !existsSync(path.join(MEDIA, 'products', `${job.slug}-1.webp`)) ||
      !existsSync(path.join(MEDIA, 'products', `${job.slug}-thumb.webp`)),
  ).map((job) => job.slug)

  process.stdout.write(
    `\ndone. ${byFile.size} assets credited, ${skipped} skipped.\n` +
      `credits -> src/data/credits.json\n`,
  )

  if (incomplete.length) {
    process.stdout.write(
      `\nINCOMPLETE — no hero image for: ${incomplete.join(', ')}\n` +
        `Re-run \`npm run assets\` to fill the gaps.\n`,
    )
  } else {
    process.stdout.write(`all ${PRODUCTS.length} products have a hero image and thumbnail.\n`)
  }
}

main().catch((err) => {
  // Never fail the build over assets; the UI degrades to CSS placeholders.
  process.stderr.write(`asset pipeline error: ${err.message}\n`)
  process.exit(0)
})
