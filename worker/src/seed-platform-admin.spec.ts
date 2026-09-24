import { describe, it, expect } from 'vitest'
import { memoryD1 } from '../test/d1-memory'
import { env } from '../test/staff-fixtures'
import { signIn } from './staff-auth'
import { derive, toB64, PBKDF2_ITERATIONS, KDF_ROUNDS } from './credentials'
import { id } from './tenancy'
import {
  MIN_PASSWORD,
  MAX_PASSWORD,
  parseArgs,
  stripTrailingNewline,
  validatePassword,
  buildInsertSql,
} from '../../scripts/seed-platform-admin.mjs'

describe('parseArgs', () => {
  it('requires both an email and a database', () => {
    expect(() => parseArgs([])).toThrow(/Usage/)
    expect(() => parseArgs(['admin@example.com'])).toThrow(/Usage/)
  })

  it('rejects a malformed email', () => {
    expect(() => parseArgs(['not-an-email', 'nexus-orders-staging'])).toThrow(/email/)
  })

  it('lowercases and trims the email, and leaves the database name as-is', () => {
    expect(parseArgs([' Admin@Example.COM ', 'nexus-orders-staging'])).toEqual({
      email: 'admin@example.com',
      database: 'nexus-orders-staging',
    })
  })
})

describe('stripTrailingNewline', () => {
  it('strips a single trailing \\r\\n (PowerShell) or \\n (Git Bash)', () => {
    expect(stripTrailingNewline('hunter2\r\n')).toBe('hunter2')
    expect(stripTrailingNewline('hunter2\n')).toBe('hunter2')
    expect(stripTrailingNewline('hunter2')).toBe('hunter2')
  })

  it('strips only one, so a password that legitimately ends in a blank line keeps the rest', () => {
    expect(stripTrailingNewline('hunter2\n\n')).toBe('hunter2\n')
  })
})

describe('validatePassword', () => {
  const neverCommon = async () => null

  it('rejects a password under MIN_PASSWORD characters', async () => {
    await expect(validatePassword('short1234', neverCommon)).rejects.toThrow(
      new RegExp(`${MIN_PASSWORD}`),
    )
  })

  it('rejects a password over MAX_PASSWORD characters', async () => {
    await expect(validatePassword('x'.repeat(MAX_PASSWORD + 1), neverCommon)).rejects.toThrow(
      new RegExp(`${MAX_PASSWORD}`),
    )
  })

  it('rejects a password tooCommon flags, surfacing its message', async () => {
    const flagged = async () => 'That password appears in 50,000 known breaches. Choose one that does not.'
    await expect(validatePassword('anything-long-enough', flagged)).rejects.toThrow(/breaches/)
  })

  it('accepts a password that is long enough and not flagged', async () => {
    await expect(validatePassword('a-fine-long-password', neverCommon)).resolves.toBeUndefined()
  })
})

describe('buildInsertSql + signIn: the seeded row verifies exactly like a registered one', () => {
  it('writes a platform staff row that signs in through staff-auth.signIn', async () => {
    const { db, raw } = memoryD1()

    const email = 'admin@example.com'
    const password = 'a very good admin password'
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
    // Exactly what `wrangler d1 execute --file` would run: a single literal
    // SQL statement, no placeholders.
    raw.prepare(sql).run()

    const row = raw.prepare(`SELECT scope, role, merchant_id FROM staff WHERE email = ?`).get(email)
    expect(row).toMatchObject({ scope: 'platform', role: 'admin', merchant_id: null })

    const res = await signIn(env(db), { email, password }, new Request('https://console.test/'))
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ totpRequired: true, enrolled: false })
    expect(res.headers?.['Set-Cookie']).toMatch(/nexus_staff=/)
  })

  it('a duplicate email fails loudly rather than silently succeeding', async () => {
    const { raw } = memoryD1()
    const row = () =>
      buildInsertSql({
        id: id('stf'),
        email: 'dup@example.com',
        passwordHash: 'hash',
        passwordSalt: 'salt',
        iterations: PBKDF2_ITERATIONS,
        kdfRounds: KDF_ROUNDS,
      })
    raw.prepare(row()).run()
    expect(() => raw.prepare(row()).run()).toThrow(/UNIQUE/)
  })
})
