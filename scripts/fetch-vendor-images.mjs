/**
 * Tier 1 of the image ladder: pull product photography from the manufacturer's
 * own CDN.
 *
 * Discovery is deliberately generic — og:image first, then <img>/srcset on the
 * product page. Writing 24 per-brand DOM extractors would be a maintenance
 * liability, and several vendors sit behind bot walls where no extractor runs.
 * Whatever this cannot reach falls through to the Commons/Unsplash pipeline in
 * fetch-assets.mjs, which already works.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/**
 * Measured failure: Nintendo's og:image is a generic `social-share.jpg` banner
 * and Samsung's is `logo-square-letter.png`. Both return HTTP 200, both are
 * valid PNGs of plausible size. Status codes say nothing about subject, so the
 * filename is the cheapest signal available before a human looks.
 */
const JUNK = /(social[-_]?share|og[-_]?default|share[-_]?image|default[-_]?meta|placeholder|sprite|logo|favicon|icon[-_]|thumb[-_]?nail)/i

const isImage = (u) => /\.(jpe?g|png|webp|avif)(\?|$)/i.test(u) || /\/is\/image\//.test(u)

export async function fetchText(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await res.text()
  // A bot wall answers 200 with a stub. Sony, LG and GoPro all return under
  // 5 KB; a real product page is tens of kilobytes at minimum.
  if (body.length < 8000) throw new Error(`stub page (${body.length} bytes) — likely a bot wall`)
  return body
}

/** og:image, then every image the page references, junk-filtered and deduped. */
export function extractImageUrls(html, pageUrl) {
  const out = []
  const push = (raw) => {
    if (!raw) return
    let u = raw.trim().replace(/&amp;/g, '&')
    if (u.startsWith('//')) u = 'https:' + u
    else if (u.startsWith('/')) u = new URL(u, pageUrl).href
    if (!/^https?:/i.test(u)) return
    if (!isImage(u) || JUNK.test(u)) return
    if (!out.includes(u)) out.push(u)
  }

  for (const m of html.matchAll(/<meta[^>]+property=["']og:image["'][^>]*>/gi)) {
    push(/content=["']([^"']+)["']/i.exec(m[0])?.[1])
  }
  for (const m of html.matchAll(/<img[^>]+>/gi)) {
    push(/\bsrc=["']([^"']+)["']/i.exec(m[0])?.[1])
    const srcset = /\bsrcset=["']([^"']+)["']/i.exec(m[0])?.[1]
    if (srcset) srcset.split(',').forEach((c) => push(c.trim().split(/\s+/)[0]))
  }

  // Storefronts built as SPAs (Google Store, OnePlus, Xiaomi) ship no <img> in
  // the served HTML — the gallery lives in a JSON blob inside a <script>, where
  // slashes arrive escaped as \/. Sweeping the raw document text finds those
  // URLs without having to know any vendor's data shape.
  const RAW = /https?:(?:\\?\/){2}[^"'\s<>\\]+?\.(?:jpe?g|png|webp|avif)(?:\?[^"'\s<>\\]*)?/gi
  for (const m of html.matchAll(RAW)) push(m[0].replace(/\\\//g, '/'))

  return out
}

const seen = new Set()

/** Downloads, rejects anything too small to be product photography, encodes. */
export async function saveImage(url, dest, width = 1400) {
  const res = await fetch(url, { headers: { 'user-agent': UA, referer: new URL(url).origin } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const meta = await sharp(buf).metadata()
  if (meta.width < 600 || meta.height < 400) throw new Error(`too small ${meta.width}x${meta.height}`)

  // Product pages embed video poster frames, and the first frame is usually a
  // fade-in from black. Apple's hero_startframe arrived as an essentially black
  // image that passed every other check. Mean luma catches it; nothing else did.
  const { channels } = await sharp(buf).flatten({ background: '#000' }).stats()
  const luma = channels.slice(0, 3).reduce((sum, c) => sum + c.mean, 0) / 3
  if (luma < 12) throw new Error(`near-black frame (luma ${luma.toFixed(1)})`)

  const encoded = await sharp(buf)
    .resize({ width, withoutEnlargement: true })
    .flatten({ background: '#0b0b0d' })     // vendor PNGs are transparent; the site is dark
    .webp({ quality: 82 })
    .toBuffer()

  const hash = createHash('md5').update(encoded).digest('hex')
  if (seen.has(hash)) throw new Error('duplicate of an image already saved')
  seen.add(hash)

  await fs.mkdir(path.dirname(dest), { recursive: true })
  await fs.writeFile(dest, encoded)
  return { source: meta.width + 'x' + meta.height, bytes: encoded.length }
}

/**
 * Site chrome appears before product photography in the document, so raw
 * document order puts nav icons and payment logos first. Anything whose URL
 * names the product wins; anything sitting in a chrome path loses.
 */
const CHROME = /\/(gnb|nav|navigation|header|footer|checkout|purchase|cart|badge|flag)\//i

export function rankCandidates(urls, keywords) {
  const score = (u) => {
    const hit = keywords.some((k) => u.toLowerCase().includes(k.toLowerCase()))
    return (hit ? -2 : 0) + (CHROME.test(u) ? 2 : 0)
  }
  return [...urls].sort((a, b) => score(a) - score(b))
}

/**
 * Walks candidates until `want` images stick. Failures drop out silently: a
 * candidate that 404s or turns out to be an icon must not stop the walk, or one
 * bad URL costs the product its whole gallery. That failure-isolation rule is
 * what took the Commons pipeline from 12/35 products to 35/35.
 */
export async function harvest(pageUrl, slug, outDir, want = 4, keywords = []) {
  const html = await fetchText(pageUrl)
  const candidates = rankCandidates(extractImageUrls(html, pageUrl), keywords)
  const saved = []
  for (const url of candidates) {
    if (saved.length >= want) break
    const dest = path.join(outDir, `${slug}-${saved.length + 1}.webp`)
    if (existsSync(dest)) { saved.push({ url, dest, skipped: true }); continue }
    try {
      const info = await saveImage(url, dest)
      saved.push({ url, dest, ...info })
    } catch { /* next candidate */ }
  }
  return { candidates: candidates.length, saved }
}
