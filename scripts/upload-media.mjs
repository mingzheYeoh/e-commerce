// Moves the catalogue's images and video from public/media to the nexus-media
// R2 bucket, served at media.nexusohm.com.
//
//   node.exe scripts/upload-media.mjs upload   # put every file (idempotent)
//   node.exe scripts/upload-media.mjs verify   # HEAD each one, write the manifest
//
// The manifest (src/data/media-manifest.json) lists only keys whose public URL
// answered 200 with the local file's exact byte length. It is what the media
// test checks references against once the local copies are gone, and the
// local copies may only be deleted after `verify` reports zero failures.
//
// search/ is skipped: it is the semantic-search index the storefront fetches
// same-origin, not a picture.
import { readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const ROOT = join(import.meta.dirname, '..')
const SRC = join(ROOT, 'public', 'media')
const BUCKET = 'nexus-media'
const ORIGIN = 'https://media.nexusohm.com'
const MANIFEST = join(ROOT, 'src', 'data', 'media-manifest.json')
const TYPES = { webp: 'image/webp', mp4: 'video/mp4', png: 'image/png', jpg: 'image/jpeg', avif: 'image/avif' }
const run = promisify(execFile)
// worker/'s wrangler: the root copy cannot start esbuild on this machine.
const WRANGLER = join(ROOT, 'worker', 'node_modules', 'wrangler', 'bin', 'wrangler.js')

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    return e.isDirectory() ? walk(p) : [p]
  })
}

const files = walk(SRC)
  .map((path) => ({ path, key: relative(SRC, path).split(sep).join('/'), bytes: statSync(path).size }))
  .filter((f) => !f.key.startsWith('search/'))

/** Runs `fn` over items, `n` at a time. */
async function pool(items, n, fn) {
  const failures = []
  let next = 0
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const item = items[next++]
        try {
          await fn(item)
        } catch (err) {
          failures.push(`${item.key}: ${String(err.message ?? err).split('\n')[0]}`)
        }
      }
    }),
  )
  return failures
}

async function upload() {
  let done = 0
  const failures = await pool(files, 4, async (f) => {
    const type = TYPES[f.key.split('.').pop()]
    if (!type) throw new Error('unknown content type')
    // node + wrangler's own entry point rather than npx: npx needs a shell on
    // Windows, and a shell splits the path and the cache-control value on
    // their spaces.
    await run(
      process.execPath,
      [WRANGLER, 'r2', 'object', 'put', `${BUCKET}/${f.key}`, '--file', f.path,
        '--remote', '--content-type', type, '--cache-control', 'public, max-age=31536000, immutable'],
      { cwd: join(ROOT, 'worker'), maxBuffer: 1 << 24 },
    )
    if (++done % 25 === 0) console.log(`${done}/${files.length}`)
  })
  report('uploaded', failures)
}

async function verify() {
  const verified = {}
  const failures = await pool(files, 8, async (f) => {
    const res = await fetch(`${ORIGIN}/${f.key}`, { method: 'HEAD' })
    const length = Number(res.headers.get('content-length'))
    if (res.status !== 200) throw new Error(`status ${res.status}`)
    if (length !== f.bytes) throw new Error(`${length} bytes, local ${f.bytes}`)
    verified[f.key] = f.bytes
  })
  const sorted = Object.fromEntries(Object.entries(verified).sort(([a], [b]) => a.localeCompare(b)))
  writeFileSync(MANIFEST, JSON.stringify({ origin: ORIGIN, files: sorted }, null, 2) + '\n')
  report('verified', failures)
}

function report(verb, failures) {
  console.log(`${verb} ${files.length - failures.length}/${files.length}`)
  for (const f of failures) console.error(`  FAIL ${f}`)
  if (failures.length) process.exit(1)
}

const mode = process.argv[2]
if (mode === 'upload') await upload()
else if (mode === 'verify') await verify()
else {
  console.error('usage: upload-media.mjs upload|verify')
  process.exit(2)
}
