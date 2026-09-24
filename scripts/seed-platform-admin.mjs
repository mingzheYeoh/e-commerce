/**
 * Creates the first platform admin.
 *
 * There is no other way: platform staff cannot register themselves, by
 * design (see worker/src/staff-auth.ts — registerMerchant only ever creates
 * a *merchant* owner). This is the one-time bootstrap, run by a human, not a
 * route the worker exposes.
 *
 * The password is read from stdin, never argv (argv shows up in shell
 * history and `ps`), never echoed, never logged, and never written to a
 * file. Validation matches registerMerchant exactly: 12–200 characters, and
 * not `tooCommon` per Have I Been Pwned's range endpoint (worker/src/pwned.ts).
 * The hash is derived with the same `derive` and the same PBKDF2_ITERATIONS /
 * KDF_ROUNDS registration uses (worker/src/credentials.ts), with a fresh
 * random salt — the row verifies through `signIn` exactly like a registered
 * account.
 *
 * The database argument is required, with no default, so nobody seeds
 * production by forgetting it.
 *
 *   node scripts/seed-platform-admin.mjs <email> <database>
 *
 * Git Bash — reads the password without echoing it to the terminal:
 *
 *   read -s -p "Admin password: " PW; echo
 *   printf '%s' "$PW" | node scripts/seed-platform-admin.mjs you@example.com nexus-orders-staging
 *   unset PW
 *
 * PowerShell:
 *
 *   $pw = Read-Host "Admin password" -AsSecureString
 *   [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($pw)) | node scripts/seed-platform-admin.mjs you@example.com nexus-orders-staging
 *   Remove-Variable pw
 *
 * Both pipes are read to end-of-stream and have exactly one trailing line
 * ending stripped here (Git Bash's `printf '%s'` sends none; PowerShell's
 * pipeline appends `\r\n`) — trusting neither shell to agree with the other
 * about line endings.
 *
 * The admin still enrols TOTP on first sign-in. The gate applies to them too.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()

// Mirrors worker/src/staff-auth.ts's MIN_PASSWORD / MAX_PASSWORD exactly. A
// platform admin's password gates every merchant's data, not one shopper's —
// it gets no weaker a rule than a merchant owner's.
export const MIN_PASSWORD = 12
export const MAX_PASSWORD = 200

/** Same shape worker/src/staff-auth.ts's isEmail checks registration against. */
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)

export function parseArgs(argv) {
  const [email, database] = argv
  if (!email || !database) {
    throw new Error('Usage: node scripts/seed-platform-admin.mjs <email> <database>')
  }
  const normalized = email.trim().toLowerCase()
  if (!isEmail(normalized)) {
    throw new Error('That email does not look right.')
  }
  return { email: normalized, database }
}

/** Strips exactly one trailing line ending, whichever shell's it is. */
export function stripTrailingNewline(raw) {
  return raw.replace(/\r\n$|\n$/, '')
}

export async function readStdinPassword(stream = process.stdin) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return stripTrailingNewline(Buffer.concat(chunks).toString('utf8'))
}

/**
 * @param tooCommon worker/src/pwned.ts's export, injected rather than
 * imported at module scope so this function is testable without esbuild or
 * the network.
 */
export async function validatePassword(password, tooCommon) {
  if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    throw new Error(`Use between ${MIN_PASSWORD} and ${MAX_PASSWORD} characters.`)
  }
  const breached = await tooCommon(password)
  if (breached) throw new Error(breached)
}

/** A single-quoted SQL literal, with embedded quotes doubled. */
export const sqlLiteral = (value) => `'${String(value).replace(/'/g, "''")}'`

/**
 * The one INSERT this script ever issues. `scope = 'platform'` and
 * `merchant_id = NULL` together are the only shape the paired CHECK on
 * `staff` accepts for platform scope (worker/migrations/0006-tenancy.sql).
 */
export function buildInsertSql({ id, email, passwordHash, passwordSalt, iterations, kdfRounds }) {
  return (
    `INSERT INTO staff (id, email, scope, merchant_id, role, password_hash, password_salt, iterations, kdf_rounds)\n` +
    `VALUES (${sqlLiteral(id)}, ${sqlLiteral(email)}, 'platform', NULL, 'admin', ` +
    `${sqlLiteral(passwordHash)}, ${sqlLiteral(passwordSalt)}, ${Number(iterations)}, ${Number(kdfRounds)});\n`
  )
}

/**
 * Bundles a worker .ts module with esbuild into a temp file and imports it.
 * Same pattern as scripts/build-graph.mjs's loadModule — the worker's TS
 * source (credentials.ts, pwned.ts, tenancy.ts) has no build step of its own
 * outside the Workers toolchain, and esbuild is already a dependency here.
 */
async function loadModule(entry) {
  // Imported dynamically, and only here: esbuild's own startup check on
  // `TextEncoder` fails under jsdom (this project's Vitest environment), so a
  // static top-level import would break importing this file's pure, testable
  // exports (parseArgs, validatePassword, buildInsertSql, ...) from a spec.
  // Nothing in the test suite calls loadModule, so the check never runs there.
  const esbuild = await import('esbuild')
  const out = path.join(os.tmpdir(), `nexus-seed-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: out,
    logLevel: 'silent',
  })
  try {
    return await import(pathToFileURL(out).href)
  } finally {
    await fs.rm(out, { force: true })
  }
}

/**
 * worker's own wrangler, not the root one — the root one cannot start esbuild
 * on this machine. Same resolution as scripts/build-catalog.mjs: bin/ is not
 * in wrangler's `exports` map, so it is reached from the package root rather
 * than resolved directly (the main entry is wrangler-dist/cli.js).
 */
function wranglerBin() {
  const main = createRequire(import.meta.url).resolve('wrangler', {
    paths: [path.join(ROOT, 'worker')],
  })
  return path.join(main, '../../bin/wrangler.js')
}

async function main(argv) {
  const { email, database } = parseArgs(argv)

  const password = await readStdinPassword()

  const [{ tooCommon }, credentials, { id }] = await Promise.all([
    loadModule(path.join(ROOT, 'worker/src/pwned.ts')),
    loadModule(path.join(ROOT, 'worker/src/credentials.ts')),
    loadModule(path.join(ROOT, 'worker/src/tenancy.ts')),
  ])
  const { derive, toB64, PBKDF2_ITERATIONS, KDF_ROUNDS } = credentials

  await validatePassword(password, tooCommon)

  const salt = crypto.getRandomValues(new Uint8Array(16))
  const hash = await derive(password, salt, KDF_ROUNDS)

  const sql = buildInsertSql({
    id: id('stf'),
    email,
    passwordHash: toB64(hash),
    passwordSalt: toB64(salt),
    iterations: PBKDF2_ITERATIONS,
    kdfRounds: KDF_ROUNDS,
  })

  // The OS temp directory, never the repo. It holds the hash and salt, not
  // the password — but it still should not linger, hence the finally below.
  const tmpFile = path.join(os.tmpdir(), `nexus-seed-admin-${process.pid}-${Date.now()}.sql`)
  await fs.writeFile(tmpFile, sql, 'utf8')
  try {
    // SEED_LOCAL is for verifying this script against `wrangler dev`'s local
    // D1 — never set it against staging or production.
    const target = process.env.SEED_LOCAL ? '--local' : '--remote'
    execFileSync(
      process.execPath,
      [wranglerBin(), 'd1', 'execute', database, target, '--file', tmpFile],
      { cwd: path.join(ROOT, 'worker'), stdio: 'inherit' },
    )
  } finally {
    await fs.rm(tmpFile, { force: true })
  }

  console.log(`\nCreated platform admin ${email} in ${database}.`)
  console.log('They must enrol TOTP on first sign-in — the gate applies to platform staff too.')
}

// Run as a script, not imported. `import.meta.main` is Node 24; this is the
// same test on 22, matching scripts/build-catalog.mjs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
}
