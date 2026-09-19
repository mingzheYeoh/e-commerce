/**
 * Renders a grid of a product's gallery so a human can confirm the images are
 * the product they claim to be.
 *
 * Every automated guard in the pipeline has shipped a wrong image at some point:
 * HTTP 200, correct dimensions and a unique content hash say nothing about
 * subject. A vendor's og:image has returned a logo and a social banner; stock
 * search has returned a rival's hardware and a building with a billboard on it.
 * This step is the one that catches those, and it is not optional.
 *
 *   node scripts/contact-sheet.mjs out.png slug-a slug-b ...
 */
import fs from 'node:fs'
import sharp from 'sharp'

const [out, ...slugs] = process.argv.slice(2)
if (!out || !slugs.length) {
  console.error('usage: node scripts/contact-sheet.mjs <out.png> <slug>...')
  process.exit(1)
}

const DIR = 'public/media/products'
const CELL = 340
const COLS = 4 // one row per product: the four gallery slots

const cells = []
for (const slug of slugs) {
  for (let n = 1; n <= COLS; n++) {
    const file = `${DIR}/${slug}-${n}.webp`
    cells.push(fs.existsSync(file) ? file : null)
  }
}

const tiles = await Promise.all(
  cells.map(async (file) =>
    file
      ? sharp(file).resize(CELL, CELL, { fit: 'contain', background: '#141417' }).png().toBuffer()
      : sharp({ create: { width: CELL, height: CELL, channels: 3, background: '#1e1e22' } })
          .png()
          .toBuffer(),
  ),
)

await sharp({
  create: {
    width: CELL * COLS,
    height: CELL * slugs.length,
    channels: 3,
    background: '#0b0b0d',
  },
})
  .composite(tiles.map((input, i) => ({ input, left: (i % COLS) * CELL, top: Math.floor(i / COLS) * CELL })))
  .png()
  .toFile(out)

slugs.forEach((s, i) => {
  const row = cells.slice(i * COLS, i * COLS + COLS)
  console.log(`row ${i + 1}  ${s.padEnd(20)} ${row.map((c) => (c ? '#' : '.')).join('')}`)
})
console.log('->', out)
