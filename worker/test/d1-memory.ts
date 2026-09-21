/**
 * A real SQLite database wearing D1's interface, for tests.
 *
 * This replaced a hand-written stand-in that matched statements with
 * `sql.includes(...)`. That stand-in grew into a small, wrong SQL engine and
 * earned its removal by hiding a bug: its `DELETE FROM sessions` branch
 * matched on the table name alone, so it swallowed both `WHERE user_id` and
 * `WHERE expires_at` — sign-out-everywhere and the nightly sweep both looked
 * like they worked while doing nothing at all.
 *
 * Running the project's own `schema.sql` instead means UNIQUE and CHECK
 * constraints are the real ones, `changes` is the real count, and a statement
 * naming a column that does not exist fails here rather than in production.
 *
 * Test-only, and outside `src/` so it cannot be pulled into the worker bundle
 * — `node:sqlite` does not exist in the Workers runtime.
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const SCHEMA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'schema.sql')

type Row = Record<string, unknown>

/**
 * D1 writes `?1, ?2`; node:sqlite binds those by name rather than by position,
 * so the argument list becomes `{1: …, 2: …}`.
 */
const named = (args: unknown[]): Record<string, SQLInputValue> =>
  Object.fromEntries(args.map((value, i) => [String(i + 1), value as SQLInputValue]))

/** Whether a chunk of the schema file is a statement or just commentary. */
const isStatement = (sql: string): boolean => sql.replace(/--[^\n]*/g, '').trim().length > 0

export interface MemoryD1 {
  db: D1Database
  /** The underlying database, for tests that want to look or meddle directly. */
  raw: DatabaseSync
  rows(table: string): Row[]
}

export function memoryD1(): MemoryD1 {
  const sqlite = new DatabaseSync(':memory:')

  const direct = (sql: string) => sqlite.prepare(sql).run()

  direct('PRAGMA foreign_keys = ON')
  // One statement at a time rather than the whole file at once: a schema that
  // fails to load then names the statement that failed.
  //
  // A trigger body (BEGIN ... ; END) contains a semicolon of its own, so a
  // naive split on every ';' would cut it in half. Chunks are re-joined
  // until BEGIN and END balance, which keeps that granularity for every
  // other statement.
  let pending = ''
  for (const chunk of readFileSync(SCHEMA, 'utf8').split(';')) {
    pending += (pending ? ';' : '') + chunk
    const begins = (pending.match(/\bBEGIN\b/gi) ?? []).length
    const ends = (pending.match(/\bEND\b/gi) ?? []).length
    if (begins > ends) continue
    if (isStatement(pending)) direct(pending)
    pending = ''
  }

  /**
   * Numbered `?1` binds as an object in node:sqlite; anonymous `?` binds
   * positionally. This worker uses both — tenancy.ts deliberately uses
   * anonymous — so the style is read off the statement rather than assumed.
   *
   * The two are separate overloads on the node:sqlite side, because a
   * named-parameter object is not itself a bindable value. So the choice is
   * made once, here, and each call site takes one branch — a single argument
   * array covering both cannot be typed without a cast that claims the object
   * is a value.
   */
  const byName = (sql: string, args: unknown[]): Record<string, SQLInputValue> | null =>
    /\?\d/.test(sql) ? named(args) : null

  const run = (sql: string, args: unknown[]) => {
    const statement = sqlite.prepare(sql)
    const bound = byName(sql, args)
    const positional = args as SQLInputValue[]
    if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql)) {
      return {
        results: (bound ? statement.all(bound) : statement.all(...positional)) as Row[],
        meta: { changes: 0 },
        success: true,
      }
    }
    const { changes } = bound ? statement.run(bound) : statement.run(...positional)
    return { results: [] as Row[], meta: { changes: Number(changes) }, success: true }
  }

  const prepare = (sql: string) => {
    const bound = (args: unknown[]) => ({
      sql,
      args,
      async run() {
        return run(sql, args)
      },
      async first<T>() {
        return ((run(sql, args).results[0] as T) ?? null) as T | null
      },
      async all<T>() {
        const out = run(sql, args)
        return { ...out, results: out.results as T[] }
      },
    })
    return { bind: (...args: unknown[]) => bound(args), ...bound([]) }
  }

  const db = {
    prepare,
    /**
     * D1 batches are atomic, so this one is too. Without the transaction a
     * failing second statement would leave the first applied — and at least
     * one code path, a racing registration, depends on that rollback.
     */
    async batch(stmts: { sql: string; args: unknown[] }[]) {
      direct('BEGIN')
      try {
        const out = stmts.map((s) => run(s.sql, s.args))
        direct('COMMIT')
        return out
      } catch (err) {
        direct('ROLLBACK')
        throw err
      }
    },
  }

  return {
    db: db as unknown as D1Database,
    raw: sqlite,
    rows: (table: string) => sqlite.prepare(`SELECT * FROM ${table}`).all() as Row[],
  }
}
