#!/usr/bin/env node
/**
 * Crops letterbox bars that arrived baked into a source image.
 *
 * Some vendor CDNs pad a product shot onto a square canvas with solid black.
 * Apple's does. On a dark page those bars are invisible until the photo itself
 * is light, and then the product sits in a box with two black stripes across
 * it — which is what this was written for.
 *
 * Not `sharp().trim()`. That trims whatever the corner pixel happens to be and
 * will happily eat a genuine dark studio background: the WH-1000XM6 is
 * photographed on near-black, and trimming it by corner colour leaves nothing.
 * This only removes bars that are *uniform across the full width* and present
 * on BOTH opposite edges, which is what padding looks like and what a
 * photograph's background does not.
 *
 *   node scripts/trim-letterbox.mjs          # report only
 *   node scripts/trim-letterbox.mjs --write  # crop in place
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const DIR = 'public/media/products'
const WRITE = process.argv.includes('--write')

/** Two colours are the same bar if every channel is within this. */
const TOLERANCE = 6
/** Below this, a "bar" is just a dark edge in the photograph. */
const MIN_BAR_FRACTION = 0.02
/**
 * Above this, we are not looking at padding any more.
 *
 * Generous on purpose. Padding a 16:9 photograph onto a square canvas puts
 * 43.75% of the height into bars, and a first cut capped at 42% therefore
 * excluded the single most common case — the iPhone shots this was written to
 * fix. The guard against over-cropping is the variation check below, not a
 * tight ceiling here.
 */
const MAX_BAR_FRACTION = 0.7

const at = (data, info, x, y) => {
  const i = (y * info.width + x) * info.channels
  return [data[i], data[i + 1], data[i + 2]]
}

function scan({ data, width, height, channels }) {
  const at = (x, y) => {
    const i = (y * width + x) * channels
    return [data[i], data[i + 1], data[i + 2]]
  }
  const same = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= TOLERANCE)
  // Sampled, not every pixel: a bar that is uniform at 32 points across the
  // width is a bar, and reading 1600 pixels per row 1600 times is not free.
  const uniformRow = (y, colour) => {
    for (let s = 0; s <= 32; s++) {
      if (!same(at(Math.min(width - 1, Math.round((s / 32) * width)), y), colour)) return false
    }
    return true
  }

  const topColour = at(width >> 1, 0)
  const bottomColour = at(width >> 1, height - 1)
  if (!same(topColour, bottomColour)) return null

  let top = 0
  while (top < height && uniformRow(top, topColour)) top++
  let bottom = 0
  while (bottom < height && uniformRow(height - 1 - bottom, topColour)) bottom++

  return { top, bottom, colour: topColour }
}

const files = (await fs.readdir(DIR)).filter((f) => f.endsWith('.webp')).sort()
const found = []

for (const file of files) {
  const full = path.join(DIR, file)
  const { data, info } = await sharp(await fs.readFile(full)).raw().toBuffer({ resolveWithObject: true })
  const bars = scan({ data, ...info })
  if (!bars) continue

  const { top, bottom } = bars
  const fraction = (top + bottom) / info.height
  /*
   * Padding is symmetric-ish and present on both edges. A 250px bar over a 3px
   * one is a dark sky above a product, not a canvas it was pasted onto, and the
   * first pass would have cropped a quarter off the Blade 16 for it.
   */
  const each = MIN_BAR_FRACTION * 0.75
  if (top / info.height < each || bottom / info.height < each) continue
  if (fraction < MIN_BAR_FRACTION || fraction > MAX_BAR_FRACTION) continue

  /*
   * And what survives has to still look like a product photograph. Without
   * this, the Galaxy S26 Ultra's dark backdrop reads as two huge bars and the
   * crop leaves a 5:1 letterbox slot with a phone somewhere in it.
   */
  const keptAspect = info.width / (info.height - top - bottom)
  if (keptAspect > 2.6) continue

  // What is left has to actually be a photograph. Without this, an image that
  // is uniform end to end reads as one enormous bar and crops to a sliver.
  const midRow = info.height >> 1
  const centre = at(data, info, info.width >> 1, midRow)
  const edge = at(data, info, 2, midRow)
  if (Math.abs(centre[0] - edge[0]) + Math.abs(centre[1] - edge[1]) + Math.abs(centre[2] - edge[2]) < 12) {
    continue
  }

  found.push({ file, top, bottom, height: info.height, width: info.width, colour: bars.colour })
}

if (!found.length) {
  console.log('no letterboxed images')
} else {
  console.log(`${found.length} of ${files.length} images carry letterbox bars:\n`)
  for (const f of found) {
    console.log(
      `  ${f.file.padEnd(28)} ${f.width}x${f.height}  ->  ${f.width}x${f.height - f.top - f.bottom}` +
        `   (${f.top}px top, ${f.bottom}px bottom, rgb(${f.colour.join(',')}))`,
    )
  }
}

if (!WRITE) {
  console.log(found.length ? '\nreport only — pass --write to crop' : '')
  process.exit(0)
}

for (const f of found) {
  const full = path.join(DIR, f.file)
  /*
   * Read into memory first. Handed a path, sharp keeps the file open, and
   * Windows then refuses to write the same path with a bare `UNKNOWN` errno
   * that names neither the lock nor the reason.
   */
  const source = await fs.readFile(full)
  const cropped = await sharp(source)
    .extract({ left: 0, top: f.top, width: f.width, height: f.height - f.top - f.bottom })
    .webp({ quality: 82 })
    .toBuffer()
  await fs.writeFile(full, cropped)
}
console.log(`\ncropped ${found.length} images in place`)
