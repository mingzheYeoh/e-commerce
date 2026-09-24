# Merchant Identity and the Write API — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give merchant staff an identity, so `products.create` and `products.update` can be exposed over HTTP without a doc comment being the only thing that stops a request from choosing its own tenant.

**Architecture:** A second worker (`nexus-console`) on its own origin, sharing `worker/src/` with the API. A staff session row is the sole source of the merchant id and staff id handed to the tenancy repository. TOTP is a gate between signing in and getting a session that can do anything.

**Tech Stack:** Cloudflare Workers, D1 (SQLite), Vitest, `node:sqlite` as the test double, WebCrypto PBKDF2 and HMAC.

## Global Constraints

- `scopedTo` and `platformWide` remain the only two entry points to merchant data. No third door.
- `rating` and `review_count` never appear in `ProductPatch`.
- A merchant id and a staff id reach the repository from a database row only. No request body carries a `merchantId` field.
- Migrations apply with `--file`, never `--command`. `worker/schema.sql` mirrors every migration.
- Money is integer minor units; the only division is in the display formatter.
- `npm run typecheck` covers `worker/` and must exit 0, never satisfied with `as unknown as` or `any`.
- Passwords are never logged, never returned, and never compared with `===`.
- Staging is `nexus-orders-staging`. **Production `nexus-orders` is not touched by this plan at all.**
- Do not merge to `main`. PRs target `staging`.

## File Structure

| File | Responsibility |
|---|---|
| `worker/migrations/0011-staff-sessions.sql` | The session table |
| `worker/schema.sql` | Fresh-database shape; mirrors the migration |
| `worker/src/credentials.ts` | PBKDF2 chain, token minting, hashing, lockout — shared |
| `worker/src/auth.ts` | Customer accounts; imports the primitives instead of owning them |
| `worker/src/staff-auth.ts` | Register, approve, sign in, the TOTP gate, `staffSession` |
| `worker/src/tenancy.ts` | Gains an async status gate |
| `worker/src/console.ts` | The console worker's entry point and routes |
| `worker/wrangler.console.toml` | Its deployment config |

---

### Task 1: The session table

**Files:**
- Create: `worker/migrations/0011-staff-sessions.sql`
- Modify: `worker/schema.sql`
- Test: `worker/src/tenancy.spec.ts` (append to the schema-constraints describe block)

**Interfaces:**
- Produces: `staff_sessions(token_hash, staff_id, created_at, expires_at, totp_pending)`. Task 5 writes it, Task 6 reads it.

- [ ] **Step 1: Write the failing tests**

Append inside `describe('the schema refuses states that must not exist', ...)` in `worker/src/tenancy.spec.ts`:

```ts
  it('will not store a staff session for a staff member who does not exist', () => {
    const { raw } = memoryD1()
    expect(() =>
      raw.prepare(`INSERT INTO staff_sessions (token_hash, staff_id, expires_at)
                   VALUES ('hash','stf_ghost','2099-01-01T00:00:00Z')`).run(),
    ).toThrow(/FOREIGN KEY/)
  })

  it('will not store a totp_pending flag that is not 0 or 1', () => {
    // SQLite has no boolean. Without the CHECK, 'yes' and 2 both store, and
    // `totp_pending` is what decides whether a session may act at all.
    const { raw } = memoryD1()
    seedMerchant(raw)
    raw.prepare(`INSERT INTO staff (id, email, scope, merchant_id, role,
                                    password_hash, password_salt, iterations)
                 VALUES ('stf_1','a@b.c','merchant','mch_a','owner','h','s',600000)`).run()
    expect(() =>
      raw.prepare(`INSERT INTO staff_sessions (token_hash, staff_id, expires_at, totp_pending)
                   VALUES ('hash','stf_1','2099-01-01T00:00:00Z', 2)`).run(),
    ).toThrow(/CHECK/)
  })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm run test -- --run worker/src/tenancy.spec.ts -t "schema refuses"`

Expected: FAIL with `no such table: staff_sessions`.

- [ ] **Step 3: Write the migration**

Create `worker/migrations/0011-staff-sessions.sql`:

```sql
-- Staff sessions, deliberately a separate table from `sessions`.
--
-- The same reasoning that kept staff out of the `users` table: one table with a
-- `kind` column makes the boundary an `if` in every query that touches it. Two
-- tables make a customer cookie and a staff cookie unable to be confused, because
-- they are looked up in different places.

CREATE TABLE IF NOT EXISTS staff_sessions (
  -- The SHA-256 of the cookie, never the cookie. A dump of this table is a list
  -- of hashes rather than a set of working keys.
  token_hash   TEXT PRIMARY KEY,
  staff_id     TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT NOT NULL,
  -- 1 while the holder has proved a password but not yet a second factor. Such
  -- a session may do exactly one thing: enrol TOTP. SQLite has no boolean, so
  -- the CHECK is what stops 'yes' and 2 from being storable in the column that
  -- decides whether a session may act at all.
  totp_pending INTEGER NOT NULL DEFAULT 0 CHECK (totp_pending IN (0, 1))
);

CREATE INDEX IF NOT EXISTS staff_sessions_staff_idx ON staff_sessions(staff_id);
-- Read by the nightly sweep. Without it that is a full scan of every session
-- ever issued.
CREATE INDEX IF NOT EXISTS staff_sessions_expiry_idx ON staff_sessions(expires_at);
```

- [ ] **Step 4: Mirror it into `schema.sql`**

Append the same `CREATE TABLE` and both indexes to `worker/schema.sql`, after the `display_order` ALTER block. Keep the comments — they are the reasoning, not decoration.

- [ ] **Step 5: Run the tests**

Run: `npm run test -- --run worker/src/tenancy.spec.ts`

Expected: PASS, including the two new tests.

- [ ] **Step 6: Apply to staging and record it**

Run: `cd worker && npx wrangler d1 execute nexus-orders-staging --remote --file=migrations/0011-staff-sessions.sql`

Expected: `success: true`.

Add the `0011` row to the applied table in `worker/migrations/README.md` (production ❌, staging ✅) **in the same commit as the migration** — that file has gone stale twice in this project, and updating it is part of applying a migration.

- [ ] **Step 7: Commit**

```bash
git add worker/migrations/0011-staff-sessions.sql worker/schema.sql worker/src/tenancy.spec.ts worker/migrations/README.md
git commit -m "feat: staff sessions get their own table

A separate table from `sessions` for the reason staff are not in `users`: one
table with a kind column makes the boundary an if statement in every query that
reads it. Two tables make a customer cookie and a staff cookie impossible to
confuse, because they are not looked up in the same place.

totp_pending carries a CHECK because SQLite has no boolean, and it is the column
that decides whether a session is allowed to act."
```

---

### Task 2: The credential primitives leave `auth.ts`

**Files:**
- Create: `worker/src/credentials.ts`
- Modify: `worker/src/auth.ts`

**Interfaces:**
- Produces, all exported from `worker/src/credentials.ts`:
  - `PBKDF2_ITERATIONS: number` and `KDF_ROUNDS: number`
  - `derive(password: string, salt: Uint8Array, rounds: number): Promise<Uint8Array>`
  - `sameBytes(a: Uint8Array, b: Uint8Array): boolean`
  - `sha256(text: string): Promise<string>`
  - `randomB64(bytes: number): string`, `randomToken(): string`
  - `toB64(bytes: Uint8Array): string`, `fromB64(text: string): Uint8Array`, `toB64Url(bytes: Uint8Array): string`
  - `nowIso(): string`, `inSeconds(s: number): string`, `isPast(iso: string | null | undefined): boolean`
  - `LOCKOUT_THRESHOLD: number`, `BACKOFF_BASE_SECONDS: number`, `BACKOFF_MAX_SECONDS: number`, `backoffSeconds(failures: number): number`
- Task 5 consumes all of these.

This task has no new behaviour. **Its acceptance test is that the whole existing suite still passes** — 389 tests, none edited.

- [ ] **Step 1: Read what you are moving**

Read `worker/src/auth.ts` lines 100-200. The helpers to move are `PBKDF2_ITERATIONS`, `KDF_ROUNDS`, `derive`, `sameBytes`, `sha256`, `randomB64`, `randomToken`, `nowIso`, `inSeconds`, `isPast`, and the base64 helpers they use. Also find the lockout constants (`failed_attempts` threshold and `locked_until` duration) and move them.

Do not move `readCookie`, `SESSION_COOKIE`, or anything that names a customer table.

- [ ] **Step 2: Create `credentials.ts`**

Move — do not copy — the declarations, exporting each one. Keep every comment verbatim: the `derive` comment explains why one round with the password as input reproduces the pre-chaining hash, and the `sameBytes` comment explains why `===` on secrets leaks. Those are the reasons the code is shaped this way.

Add a file header:

```ts
/**
 * What proves someone is who they say they are.
 *
 * Extracted from auth.ts when staff sign-in arrived: two systems with different
 * rules needed the same primitives, and the alternative was a second copy that
 * drifts. Nothing here knows about customers or merchants — it takes a password
 * and a salt, or it mints a token.
 */
```

- [ ] **Step 3: Have `auth.ts` import them**

Replace the moved declarations with one import. `auth.ts` must not re-export them; consumers import from `credentials.ts`.

- [ ] **Step 4: Run the whole suite**

Run: `npm run test && npm run typecheck`

Expected: 389 passed, typecheck exit 0, **and no test file edited**. If a test needed changing, something moved that should not have. Say so rather than editing the test.

- [ ] **Step 5: Commit**

```bash
git add worker/src/credentials.ts worker/src/auth.ts
git commit -m "refactor: the credential primitives are not auth.ts's alone

Staff sign-in needs the same PBKDF2 chain, the same constant-time comparison and
the same token minting that customer accounts use. The alternative to sharing
them is a second copy that drifts, in the half of the system where drift means a
weaker hash nobody notices.

auth.ts was 1342 lines before this. Adding staff sign-in to it would have made
one oversized file serve two systems with different rules - the shape the
tenancy design rejected when it kept staff out of the users table."
```

---

### Task 3: A repository for a merchant who is not active

**Files:**
- Modify: `worker/src/tenancy.ts`
- Test: `worker/src/tenancy.spec.ts`

**Interfaces:**
- Produces: `scopedTo(env, merchantId, staffId): Promise<Repository>` — **now async**, and rejects when the merchant's `status` is not `active`. `platformWide(env, staffId): Promise<Repository>` is made async too, for symmetry, but has no status to check.
- Tasks 6 and 7 consume the new signatures.

`merchants.status` has a `CHECK (status IN ('pending','active','suspended'))` written in `0006` and **nothing has ever read it.** It was unanswerable while no sign-in path existed. This plan makes it reachable, and the default answer is wrong.

Changing these signatures is free today and expensive later: `tenancy.ts` currently has no importers outside its own spec.

- [ ] **Step 1: Write the failing tests**

Append to `worker/src/tenancy.spec.ts`:

```ts
describe('a merchant who is not active', () => {
  const seed = (status: string) => {
    const mem = memoryD1()
    mem.raw.prepare(`INSERT INTO merchants (id, slug, name, settlement_currency, status)
                     VALUES ('mch_a','a','A','USD', ?)`).run(status)
    mem.raw.prepare(`INSERT INTO products (id, merchant_id, sku, title, brand, category,
                                           price_minor, currency, status, stock_count)
                     VALUES ('p1','mch_a','S','T','B','C',100,'USD','published',1)`).run()
    return mem
  }

  it('hands out no repository at all while the application is pending', async () => {
    // Refused here rather than at the route, so a route added later inherits it
    // without its author having to know this rule exists.
    const { db } = seed('pending')
    await expect(scopedTo(db4(db), 'mch_a', 'stf_1')).rejects.toThrow(/not active/i)
  })

  it('hands out no repository once a merchant is suspended', async () => {
    const { db } = seed('suspended')
    await expect(scopedTo(db4(db), 'mch_a', 'stf_1')).rejects.toThrow(/not active/i)
  })

  it('hands one out for an active merchant', async () => {
    const { db } = seed('active')
    const repo = await scopedTo(db4(db), 'mch_a', 'stf_1')
    expect(await repo.products.list()).toHaveLength(1)
  })

  it('refuses a merchant id that does not exist', async () => {
    const { db } = seed('active')
    await expect(scopedTo(db4(db), 'mch_ghost', 'stf_1')).rejects.toThrow(/not active/i)
  })
})
```

`db4` is whatever the existing tests in this file use to wrap a `D1Database` into `TenancyEnv` — read them and reuse it rather than inventing a second helper. If there is no such helper, it is `(db: D1Database) => ({ ORDERS: db })`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npm run test -- --run worker/src/tenancy.spec.ts -t "not active"`

Expected: FAIL — `scopedTo` returns a `Repository`, not a promise, so `rejects` has nothing to await.

- [ ] **Step 3: Make the two doors async**

In `worker/src/tenancy.ts`:

```ts
/**
 * A merchant's own data, and nothing else.
 *
 * Async because it verifies the merchant is active before handing anything
 * back. `merchants.status` had a CHECK from the first migration and no reader
 * until staff could sign in — a dormant constraint whose default answer, once
 * the question became reachable, was "yes, go ahead".
 *
 * The check lives here rather than in a route so that a route added later gets
 * it without its author knowing the rule exists.
 *
 * @param merchantId MUST come from the staff session row, never a request body.
 *   This does not verify staffId belongs to merchantId.
 */
export const scopedTo = async (
  env: TenancyEnv,
  merchantId: string,
  staffId: string,
): Promise<Repository> => {
  const row = await env.ORDERS.prepare(`SELECT status FROM merchants WHERE id = ?`)
    .bind(merchantId)
    .first<{ status: string }>()
  if (row?.status !== 'active') {
    // One message for "no such merchant" and for "suspended": the caller's only
    // sensible response to both is the same, and a distinction here would
    // eventually be surfaced as one.
    throw new Error(`merchant ${merchantId} is not active`)
  }
  return build(env, { kind: 'merchant', merchantId, staffId })
}

/** Everything, for platform staff. */
export const platformWide = async (env: TenancyEnv, staffId: string): Promise<Repository> =>
  build(env, { kind: 'platform', staffId })
```

Update the existing tests in this file that call `scopedTo`/`platformWide` to `await` them. The isolation sweep, the audit tests and the completeness test all construct repositories — every one needs the `await`, and `methodNames(await scopedTo(...))` in the completeness test too.

- [ ] **Step 4: Run the whole file**

Run: `npm run test -- --run worker/src/tenancy.spec.ts && npm run typecheck`

Expected: PASS, typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add worker/src/tenancy.ts worker/src/tenancy.spec.ts
git commit -m "feat: a merchant who is not active gets no repository

merchants.status has carried a CHECK since the first tenancy migration and
nothing has ever read it. That was fine while no sign-in path existed - the
question was unreachable. Giving staff a way in makes it reachable, and the
answer it would have given by default is that a pending applicant and a
suspended seller both have full access to their own data.

Refused at the repository rather than at a route, so a route written later
inherits it without its author needing to know the rule is there. Both doors
become async; nothing outside this file's own spec called them yet, which is
why the signature change costs nothing today and would not later."
```

---

### Task 4: Registration and approval

**Files:**
- Create: `worker/src/staff-auth.ts`
- Test: `worker/src/staff-auth.spec.ts`

**Interfaces:**
- Consumes: `credentials.ts` (Task 2), `tooCommon` from `worker/src/pwned.ts`.
- Produces:
  - `registerMerchant(env, body): Promise<StaffResult>` — creates `merchants(status='pending')` and `staff(scope='merchant', role='owner')`
  - `approveMerchant(env, staffId, merchantId, slug): Promise<StaffResult>` — platform only; assigns the storefront address and flips status to `active`
  - `type StaffResult = { status: number; body: Record<string, unknown> }`
- Task 5 and Task 6 consume both.

- [ ] **Step 1: Write the failing tests**

Create `worker/src/staff-auth.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { memoryD1 } from '../test/d1-memory'
import { registerMerchant, approveMerchant } from './staff-auth'

const env = (db: D1Database) => ({ ORDERS: db })
const good = { email: 'owner@example.com', name: 'Acme', slug: 'acme', password: 'Xq7!vurnLp2$wedge' }

describe('registerMerchant', () => {
  it('creates a pending merchant and its owner', async () => {
    const { db, raw } = memoryD1()
    const res = await registerMerchant(env(db), good)
    expect(res.status).toBe(201)

    const merchant = raw.prepare(`SELECT status, slug FROM merchants`).get()
    expect(merchant).toMatchObject({ status: 'pending', slug: 'acme' })

    const staff = raw.prepare(`SELECT scope, role, totp_secret FROM staff`).get()
    expect(staff).toMatchObject({ scope: 'merchant', role: 'owner', totp_secret: null })
  })

  it('never stores the password', async () => {
    const { db, raw } = memoryD1()
    await registerMerchant(env(db), good)
    const row = JSON.stringify(raw.prepare(`SELECT * FROM staff`).get())
    expect(row).not.toContain(good.password)
  })

  it('refuses a password found in a breach corpus', async () => {
    const { db } = memoryD1()
    const res = await registerMerchant(env(db), { ...good, password: 'password123' })
    expect(res.status).toBe(400)
  })

  it('refuses a duplicate email without saying it is taken', async () => {
    // The same reason the customer side refuses to confirm an address exists:
    // a signup form that distinguishes is an account-enumeration oracle.
    const { db } = memoryD1()
    await registerMerchant(env(db), good)
    const res = await registerMerchant(env(db), { ...good, slug: 'other' })
    expect(res.status).toBe(202)
    expect(JSON.stringify(res.body)).not.toMatch(/taken|exists|duplicate/i)
  })

  it('leaves nothing behind when the slug is already used', async () => {
    const { db, raw } = memoryD1()
    await registerMerchant(env(db), good)
    await registerMerchant(env(db), { ...good, email: 'other@example.com' })
    // A merchant row without its owner is an application nobody can ever claim.
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM merchants`).get()).toEqual({ n: 1 })
  })
})

describe('approveMerchant', () => {
  it('turns a pending application active', async () => {
    const { db, raw } = memoryD1()
    await registerMerchant(env(db), good)
    const id = (raw.prepare(`SELECT id FROM merchants`).get() as { id: string }).id
    const res = await approveMerchant(env(db), 'stf_platform', id, 'acme')
    expect(res.status).toBe(200)
    expect(raw.prepare(`SELECT status FROM merchants`).get()).toEqual({ status: 'active' })
  })

  it('records who approved it', async () => {
    const { db, raw } = memoryD1()
    await registerMerchant(env(db), good)
    const id = (raw.prepare(`SELECT id FROM merchants`).get() as { id: string }).id
    await approveMerchant(env(db), 'stf_platform', id, 'acme')
    const audit = raw.prepare(`SELECT actor_id, action, merchant_id FROM audit_log`).get()
    expect(audit).toMatchObject({ actor_id: 'stf_platform', merchant_id: id })
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm run test -- --run worker/src/staff-auth.spec.ts`

Expected: FAIL — cannot resolve `./staff-auth`.

- [ ] **Step 3: Implement**

Create `worker/src/staff-auth.ts`. Requirements the tests encode, stated so you do not have to infer them:

- The merchant row and the staff row are written in **one `env.ORDERS.batch([...])`**. A merchant with no owner is an application nobody can claim, and D1's batch is the only atomicity available here.
- A duplicate email returns **202 with the same body a success returns**. A registration form that distinguishes is an account-enumeration oracle, which is the reason the customer side does the same.
- `tooCommon(password)` from `worker/src/pwned.ts` returns a string reason or `null`. A non-null reason is a 400. It is keyless — it hashes the password and sends the first five characters of the SHA-1 to HIBP's range API, so the password never leaves the process.
- Password minimum length 12. Shorter is a 400.
- Ids: `mch_` and `stf_` prefixes, the same generator style `tenancy.ts` uses for `aud_`.
- `approveMerchant` writes the audit row itself — it changes `merchants`, which the tenancy repository does not cover.

- [ ] **Step 4: Run the tests**

Run: `npm run test -- --run worker/src/staff-auth.spec.ts && npm run typecheck`

Expected: PASS, typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add worker/src/staff-auth.ts worker/src/staff-auth.spec.ts
git commit -m "feat: a merchant can apply, and the platform can approve

Registration writes the merchant and its owner in one batch: a merchant row
without an owner is an application nobody can ever claim.

A duplicate email answers exactly as a success does. A registration form that
distinguishes tells a stranger which addresses have accounts, and that is worth
more to an attacker than the form is to them.

Approval writes its own audit row - it changes `merchants`, which the tenancy
repository does not cover, so the wrapper that audits everything else cannot
see it."
```

---

### Task 5: Signing in, and TOTP as a gate

**Files:**
- Modify: `worker/src/staff-auth.ts`
- Test: `worker/src/staff-auth.spec.ts`

**Interfaces:**
- Consumes: `credentials.ts`, `verifyTotp`/`newTotpSecret` from `worker/src/totp.ts`.
- Produces:
  - `type StaffSession = { kind: 'enrolling'; staffId: string } | { kind: 'active'; staffId: string; merchantId: string | null; scope: 'merchant' | 'platform' }`
  - `staffSession(env, request): Promise<StaffSession | null>`
  - `signIn(env, body, request): Promise<StaffResult>` — sets the cookie
  - `beginTotpEnrolment(env, session): Promise<StaffResult>` — returns the secret and its otpauth URI
  - `confirmTotpEnrolment(env, session, body): Promise<StaffResult>` — on success clears `totp_pending`
  - `STAFF_COOKIE = 'nexus_staff'`
- Task 6 consumes all of these.

- [ ] **Step 1: Write the failing tests**

Append to `worker/src/staff-auth.spec.ts`:

```ts
describe('signing in', () => {
  it('returns an enrolling session when TOTP has never been confirmed', async () => {
    const { db } = await activeMerchant()
    const res = await signIn(env(db), { email: good.email, password: good.password }, req())
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ totpRequired: true })

    const session = await staffSession(env(db), withCookie(res))
    expect(session).toEqual({ kind: 'enrolling', staffId: expect.any(String) })
  })

  it('an enrolling session carries no merchant id, so it cannot be scoped', async () => {
    // The point of the union: scopedTo cannot be called with this, because
    // there is no argument to pass - not because a check refuses it.
    const { db } = await activeMerchant()
    const res = await signIn(env(db), { email: good.email, password: good.password }, req())
    const session = await staffSession(env(db), withCookie(res))
    expect(session).not.toHaveProperty('merchantId')
  })

  it('promotes the session to active once a code verifies', async () => {
    const { db } = await activeMerchant()
    const signedIn = await signIn(env(db), { email: good.email, password: good.password }, req())
    const enrolling = (await staffSession(env(db), withCookie(signedIn)))!

    const begun = await beginTotpEnrolment(env(db), enrolling)
    const secret = (begun.body as { secret: string }).secret
    await confirmTotpEnrolment(env(db), enrolling, { code: await totpCode(secret) })

    const after = await staffSession(env(db), withCookie(signedIn))
    expect(after).toMatchObject({ kind: 'active', merchantId: expect.any(String), scope: 'merchant' })
  })

  it('a wrong code neither promotes the session nor consumes it', async () => {
    const { db } = await activeMerchant()
    const signedIn = await signIn(env(db), { email: good.email, password: good.password }, req())
    const enrolling = (await staffSession(env(db), withCookie(signedIn)))!
    await beginTotpEnrolment(env(db), enrolling)

    const res = await confirmTotpEnrolment(env(db), enrolling, { code: '000000' })
    expect(res.status).toBe(400)
    expect(await staffSession(env(db), withCookie(signedIn))).toMatchObject({ kind: 'enrolling' })
  })

  it('refuses a wrong password without saying which half was wrong', async () => {
    const { db } = await activeMerchant()
    const res = await signIn(env(db), { email: good.email, password: 'wrong-but-long-enough' }, req())
    expect(res.status).toBe(401)
    expect(JSON.stringify(res.body)).not.toMatch(/password|email|unknown user/i)
  })

  it('locks the account after repeated failures', async () => {
    const { db } = await activeMerchant()
    for (let i = 0; i < 5; i++) {
      await signIn(env(db), { email: good.email, password: 'wrong-but-long-enough' }, req())
    }
    const res = await signIn(env(db), { email: good.email, password: good.password }, req())
    expect(res.status).toBe(423)
  })

  it('requires the second factor on every later sign-in', async () => {
    const { db } = await activeMerchant()
    // enrol once
    const first = await signIn(env(db), { email: good.email, password: good.password }, req())
    const enrolling = (await staffSession(env(db), withCookie(first)))!
    const begun = await beginTotpEnrolment(env(db), enrolling)
    const secret = (begun.body as { secret: string }).secret
    await confirmTotpEnrolment(env(db), enrolling, { code: await totpCode(secret) })

    // sign in again: password alone must not produce an active session
    const second = await signIn(env(db), { email: good.email, password: good.password }, req())
    expect(second.body).toMatchObject({ totpRequired: true })
    expect(await staffSession(env(db), withCookie(second))).toMatchObject({ kind: 'enrolling' })
  })
})
```

Write these helpers at the top of the describe block:

```ts
const req = () => new Request('https://console.test/api/staff/signin', { method: 'POST' })

/** Registers, approves, and hands back a database with an active merchant. */
async function activeMerchant() {
  const mem = memoryD1()
  await registerMerchant(env(mem.db), good)
  const id = (mem.raw.prepare(`SELECT id FROM merchants`).get() as { id: string }).id
  const approved = await approveMerchant(env(mem.db), 'stf_platform', id, 'acme')
  if (approved.status !== 200) throw new Error(`fixture approval failed: ${approved.status}`)
  return mem
}

/** A request carrying the cookie a StaffResult set. */
function withCookie(res: StaffResult): Request {
  const cookie = String(res.headers?.['Set-Cookie'] ?? '').split(';')[0]
  return new Request('https://console.test/', { headers: { Cookie: cookie } })
}
```

`StaffResult` gains an optional `headers?: Record<string, string>` for this. Import `totpCode` from `./totp`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npm run test -- --run worker/src/staff-auth.spec.ts -t "signing in"`

Expected: FAIL — `signIn` is not exported.

- [ ] **Step 3: Implement**

Requirements the tests encode:

- **Every sign-in starts as `totp_pending = 1`,** whether or not TOTP was already confirmed. The last test is the one that matters: a password alone must never produce an active session, not even on the hundredth sign-in.
- `staffSession` returns `{ kind: 'enrolling' }` when the row's `totp_pending` is 1, and `{ kind: 'active', merchantId, scope }` when it is 0. **Only the active branch carries `merchantId`.**
- A wrong password and an unknown email answer identically, with a 401 and no detail.
- **A correct password for a staff member of a non-`active` merchant answers exactly as a wrong password does** — 401, the same body, the same KDF cost, and it **increments `failed_attempts` and engages the same backoff**. This closes an enumeration channel that registration cannot close on its own: an attacker registers a victim's address with a password *they* chose, then signs in with it. If a pending account's correct password were distinguishable, `signIn` would answer 200 for an account the probe just created and 401 for one that already existed. The lockout clause matters as much as the status: skip it and six attempts read the difference anyway, because a pre-existing account locks and returns 423 while an attacker-created one never does. A genuine applicant discovers approval by signing in, as spec Section 0 says; before approval they are refused like anyone else, and the backoff is bounded, not permanent.
- Lockout: reuse `backoffSeconds` from `credentials.ts` — **do not invent a flat duration.** The customer side does exponential backoff (5 failures → 60s, then doubling to a 900s cap), and the decision for this feature was that staff get a *stricter* posture than customers, not a looser one. A flat lock would be looser. `failed_attempts` increments on each failure and `locked_until` is set to `backoffSeconds(failures)` ahead; a locked account answers 423 even with the right password.

  The plan originally named a `LOCKOUT_MINUTES` constant here. That was a misreading of what `auth.ts` does, caught during Task 2 — there is no flat duration to share, only the backoff function.
- `confirmTotpEnrolment` on success writes `totp_confirmed_at` and sets `totp_pending = 0` on **that session row only**. Other sessions for the same staff member stay pending.
- The cookie is `HttpOnly; Secure; SameSite=Strict; Path=/`. Strict rather than Lax, because the console is same-origin with its own SPA and has no cross-site navigation to accommodate.

- [ ] **Step 4: Run the tests**

Run: `npm run test -- --run worker/src/staff-auth.spec.ts && npm run typecheck`

Expected: PASS, typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add worker/src/staff-auth.ts worker/src/staff-auth.spec.ts
git commit -m "feat: a password gets you as far as enrolling a second factor

Every sign-in starts pending, including the hundredth. A session that has proved
only a password can do exactly one thing, and it is not a flag anyone has to
remember to read: the enrolling branch of the union carries no merchant id, so
scopedTo cannot be called with it - there is no argument to pass.

That is the same move as the staff table's paired CHECK, applied to a type
instead of a column: the dangerous state is not refused, it is unrepresentable."
```

---

### Task 6: The console worker

**Files:**
- Create: `worker/src/console.ts`
- Create: `worker/wrangler.console.toml`
- Modify: `package.json` (a deploy script)
- Test: `worker/src/console.spec.ts`

**Interfaces:**
- Consumes: everything from Tasks 3, 4 and 5.
- Produces: the routes in the spec's Section 5.

- [ ] **Step 1: Write the failing tests**

Create `worker/src/console.spec.ts` exercising the fetch handler directly:

```ts
import { describe, it, expect } from 'vitest'
import worker from './console'
import { memoryD1 } from '../test/d1-memory'
// plus the activeMerchant/withCookie helpers — import them from a shared test
// module rather than copying; if that means extracting them from
// staff-auth.spec.ts into worker/test/staff-fixtures.ts, do that.

describe('the console worker', () => {
  it('refuses every merchant route without a session', async () => {
    const { db } = memoryD1()
    for (const [method, path] of [
      ['GET', '/api/merchant/products'],
      ['POST', '/api/merchant/products'],
      ['PATCH', '/api/merchant/products/p1'],
    ] as const) {
      const res = await worker.fetch(new Request(`https://console.test${path}`, { method }), { ORDERS: db })
      expect(res.status).toBe(401)
    }
  })

  it('refuses every merchant route with an enrolling session', async () => {
    // The gate is the point: a password alone reaches nothing.
    const { db, cookie } = await enrollingSession()
    const res = await worker.fetch(
      new Request('https://console.test/api/merchant/products', { headers: { Cookie: cookie } }),
      { ORDERS: db },
    )
    expect(res.status).toBe(403)
  })

  it('lists only the signed-in merchant's products', async () => {
    const { db, cookie, merchantId } = await activeSession()
    seedProduct(db, merchantId, 'mine')
    seedProduct(db, 'mch_other', 'LEAK')
    const res = await worker.fetch(
      new Request('https://console.test/api/merchant/products', { headers: { Cookie: cookie } }),
      { ORDERS: db },
    )
    expect(JSON.stringify(await res.json())).not.toContain('LEAK')
  })

  it('creates a product under the session's merchant, whatever the body says', async () => {
    const { db, cookie, merchantId } = await activeSession()
    const res = await worker.fetch(
      new Request('https://console.test/api/merchant/products', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        // merchantId in the body is ignored because the type has no such field.
        body: JSON.stringify({ merchantId: 'mch_other', sku: 'S1', title: 'T', brand: 'B',
                               category: 'C', priceMinor: 1000 }),
      }),
      { ORDERS: db },
    )
    expect(res.status).toBe(201)
    const row = (await res.json()) as { merchantId: string }
    expect(row.merchantId).toBe(merchantId)
  })

  it('refuses to patch another merchant's product', async () => {
    const { db, cookie } = await activeSession()
    seedProduct(db, 'mch_other', 'theirs')
    const res = await worker.fetch(
      new Request('https://console.test/api/merchant/products/theirs', {
        method: 'PATCH',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ priceMinor: 1 }),
      }),
      { ORDERS: db },
    )
    expect(res.status).toBe(404)
  })

  it('refuses a platform route to merchant staff', async () => {
    const { db, cookie } = await activeSession()
    const res = await worker.fetch(
      new Request('https://console.test/api/platform/merchants', { headers: { Cookie: cookie } }),
      { ORDERS: db },
    )
    expect(res.status).toBe(403)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm run test -- --run worker/src/console.spec.ts`

Expected: FAIL — cannot resolve `./console`.

- [ ] **Step 3: Write the worker**

`worker/src/console.ts` exports a default `{ fetch(request, env) }`. Requirements:

- A merchant route reads its scope like this and no other way:

```ts
const session = await staffSession(env, request)
if (!session) return json({ error: 'not signed in' }, { status: 401 })
if (session.kind === 'enrolling') return json({ error: 'second factor required' }, { status: 403 })
if (session.scope !== 'merchant') return json({ error: 'not a merchant account' }, { status: 403 })
const db = await scopedTo(env, session.merchantId!, session.staffId)
```

- **Call `scopedTo` fresh on every request. Never cache a `Repository`, never hang one off a session.** Its active-merchant check runs once, when the repository is vended — proven by suspending a merchant after `scopedTo` returned and successfully calling `.products.create()` on the stale object. A repository held across requests keeps working for a merchant who has since been suspended, which silently reopens the hole Task 3 exists to close. The per-request `SELECT status FROM merchants` is not overhead to optimise away; it is the authorisation.

- Patching a product that belongs to someone else is a **404, not a 403**. The repository returns nothing for it, and "this exists but is not yours" tells a stranger the id is real.
- **Registration does not accept a slug; approval does.** An applicant-chosen slug leaks whether an email is registered through the side effect rather than the answer: a successful registration consumes a globally unique, publicly probeable value, so two probes with one throwaway slug read the difference. Registration mints `pending_<random>`; the approve route takes the real storefront address in its body (`{ slug }`) and must reject one that is malformed or already taken. A 409 to an authorised platform admin leaks nothing — they can already see every merchant.

- **`approveMerchant(env, staffId, merchantId, slug)` cannot check that the caller is platform staff.** Its `staffId` argument is an unverified claim — the same trust `scopedTo` places in its `merchantId`, and documented in the function the same way. The platform routes must therefore refuse anything whose session `scope` is not `'platform'` **before** calling it. A merchant staffer reaching `/api/platform/merchants/:id/approve` and approving their own pending application is the concrete failure, and nothing below the route will stop it.

- The create body type has **no `merchantId` field**. That is what makes the fourth test pass without a check.
- The top-level catch returns a generic 500 and logs the error, matching `index.ts`.
- `scopedTo` throwing for a non-active merchant becomes a 403, not a 500 — a suspended seller's own request is refused, not broken.

- [ ] **Step 4: Write the config**

`worker/wrangler.console.toml`:

```toml
# The merchant console. A separate worker from nexus-api, on its own origin,
# because an authentication surface that moves origin later costs every live
# session plus the allow-list, CORS and deploy scripts that name it.
#
# Same directory as the API on purpose: tenancy.ts and credentials.ts are
# ordinary imports rather than a cross-project path.
name = "nexus-console"
main = "src/console.ts"
compatibility_date = "2026-09-01"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "ORDERS"
database_name = "nexus-orders"
database_id = "7aa62821-d17f-43a2-b605-2643780e9690"

[env.staging]
name = "nexus-console-staging"

[[env.staging.d1_databases]]
binding = "ORDERS"
database_name = "nexus-orders-staging"
database_id = "aedb0572-7924-4068-8d30-11b6e61eeed5"
```

Add to the root `package.json`:

```json
"deploy:console:staging": "npx --prefix worker wrangler deploy -c wrangler.console.toml --env staging"
```

Do **not** add a production deploy script. Production has none of migrations 0007-0011 — see `worker/migrations/README.md`.

- [ ] **Step 5: Run the tests**

Run: `npm run test && npm run typecheck`

Expected: all green, typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add worker/src/console.ts worker/src/console.spec.ts worker/wrangler.console.toml package.json
git commit -m "feat: the console worker, and the routes that can write

Every merchant route takes its tenant from the session row and from nowhere
else. The create body has no merchantId field at all, so the request cannot
name a tenant even dishonestly - the test that sends one proves it is ignored
without any code having to ignore it.

A product belonging to someone else is a 404 rather than a 403. The repository
returns nothing for it either way, and 'this exists but is not yours' hands a
stranger a confirmed id.

Its own worker, sharing worker/src rather than a second directory: one
node_modules, one tsconfig, and tenancy.ts is an ordinary import."
```

---

### Task 7: The sweep that proves the route layer

**Files:**
- Test: `worker/src/console.spec.ts` (append)

**Interfaces:**
- Consumes: everything.
- Produces: nothing. This is the guard that keeps Tasks 3-6 honest as routes are added.

The tenancy core already proves the *repository* holds under a poisoned second tenant. This proves the *route layer* never hands it the wrong scope — a different failure, and the one this plan introduces the possibility of.

- [ ] **Step 1: Write the sweep**

```ts
describe('no route lets a request choose its tenant', () => {
  /*
   * Every merchant route, called with a valid session for merchant A while
   * every id in the path and the body names merchant B. B's data is marked, and
   * the assertion is only that the marker never appears in A's answer - no
   * knowledge of each response's shape is needed.
   *
   * Adding a route without adding it here is what the count assertion catches.
   */
  const ROUTES: [string, string, unknown?][] = [
    ['GET', '/api/merchant/products'],
    ['POST', '/api/merchant/products', { merchantId: 'mch_b', sku: 'LEAK', title: 'LEAK',
                                         brand: 'B', category: 'C', priceMinor: 1 }],
    ['PATCH', '/api/merchant/products/LEAK_product', { priceMinor: 1 }],
  ]

  it('never returns the other merchant's data', async () => {
    for (const [method, path, body] of ROUTES) {
      const { db, cookie } = await activeSession()
      seedMerchant(db, 'mch_b', 'active')
      seedProduct(db, 'mch_b', 'LEAK_product')
      const res = await worker.fetch(
        new Request(`https://console.test${path}`, {
          method,
          headers: { Cookie: cookie, 'Content-Type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
        }),
        { ORDERS: db },
      )
      expect(JSON.stringify(await res.json())).not.toContain('LEAK_product')
    }
  })

  it('has a case for every merchant route the worker serves', async () => {
    // Without this, the sweep covers whatever somebody remembered.
    const source = readFileSync('worker/src/console.ts', 'utf8')
    const served = [...source.matchAll(/'\/api\/merchant\/[^']*'/g)].map((m) => m[0])
    expect(new Set(served).size).toBe(new Set(ROUTES.map(([, p]) => p.split('/:')[0])).size)
  })
})
```

If matching route literals out of the source proves brittle, replace the second test with an exported `MERCHANT_ROUTES` array in `console.ts` that the router iterates and the test compares against — **say in your report which you did.** The property that matters is that a route added without a case turns the suite red.

- [ ] **Step 2: Run it**

Run: `npm run test -- --run worker/src/console.spec.ts`

Expected: PASS.

- [ ] **Step 3: Prove it catches an uncovered route**

Temporarily add a `GET /api/merchant/orders` route returning `{}`. Run the completeness test.

Expected: FAIL — the counts differ. Remove the route again; it belongs to a later plan.

- [ ] **Step 4: Commit**

```bash
git add worker/src/console.spec.ts
git commit -m "test: the route list must equal the case list

The tenancy core proves the repository holds under a poisoned second tenant.
This proves the route layer never hands it the wrong scope, which is a different
failure and the one this plan makes possible for the first time.

Proven to catch it: adding a merchant route without a case turns this red."
```

---

## Self-Review

**Spec coverage.** §0 registration-without-mail → Task 4. §1 session as sole source → Tasks 1, 5, 6. §2 credential extraction → Task 2. §3 registration/approval/TOTP gate → Tasks 4, 5. §4 `merchants.status` refuses → Task 3. §5 the write API → Task 6. §6 the second worker → Task 6 Step 4. §7's three properties → Task 6's tests and Task 7's sweep.

**Types.** `StaffResult` is introduced in Task 4 and gains `headers?` in Task 5. `StaffSession` is the union from Task 5, consumed in Tasks 6 and 7. `scopedTo` is async from Task 3 onward and every later task awaits it.

**Known gap left to the executor.** Task 7's completeness test has two possible shapes and the plan does not pick one, because which is brittle depends on how Task 6's router ends up written. The executor picks and reports.
