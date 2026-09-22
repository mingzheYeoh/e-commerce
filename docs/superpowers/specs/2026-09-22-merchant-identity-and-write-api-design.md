# Merchant identity and the write API

**Date:** 2026-09-22
**Status:** approved, ready for an implementation plan.
**Depends on:** `2026-09-21-merchant-admin-design.md` (the tenancy core) and
`2026-09-21-catalogue-migration-design.md` (the catalogue in D1, merged as PR #15).

Plan ② of three. ① put the catalogue in the database. This one gives merchant
staff an identity and lets them write. ③ is the console SPA.

---

## Section 0 — registration without email, and why that is not a fudge

The decision was self-serve merchant registration with a pending-approval gate.
`RESEND_API_KEY` is unset on both environments, so there is no email
verification available. That combination is sound here, and the reason is worth
writing down because it does not generalise.

```
a customer registering unverified   the account works immediately, and the
                                    address may not be theirs
a merchant registering unverified   the account is `pending` and can do nothing
                                    until a person at NEXUS approves it
```

**The approval gate does the work email verification would have done**, for the
risk that actually matters, and it is a synchronous human gate rather than an
automated one. A fraudulent application sits inert.

What verification would still buy, and what is therefore deferred: proof that
the applicant can receive mail at that address, and protection against
squatting on someone else's. Neither is load-bearing while approval is manual.

The real cost, stated plainly: **an approved applicant cannot be told they were
approved.** They discover it by trying to sign in. That is a genuine gap, and
it closes when `RESEND_API_KEY` exists. The schema leaves room — `staff` can
gain `email_verified_at` the same way `users` has it — and nothing in this
design has to change to add it.

## Section 1 — the session is the only source of truth

The tenancy core's largest residual risk is that `scopedTo(env, merchantId,
staffId)` takes two bare strings and trusts that the caller checked they belong
together. Today a doc comment is the whole defence. This plan retires it.

`0011-staff-sessions.sql` adds one table:

```
staff_sessions        token_hash · staff_id · created_at · expires_at · totp_pending
staffSession(env, req)  → the staff row behind the cookie, with merchant_id and scope

a route handler       scopedTo(env, session.merchantId, session.id)
                                    ↑ both from the database row, never from the request
```

The comment currently reads "`merchantId` MUST come from the staff session row,
never a request body." After this plan that is structural rather than
disciplinary: **no request body has a `merchantId` field to supply.** A merchant
route reads its tenant from the session and from nowhere else, and a platform
route calls `platformWide(env, session.id)` on the same evidence.

The session table mirrors `sessions` deliberately: the SHA-256 of the cookie,
never the cookie. A dump is a list of hashes rather than a set of working keys.

## Section 2 — the credential primitives come out of `auth.ts`

`worker/src/auth.ts` is 1342 lines and holds every customer-account operation.
Three things inside it are what staff authentication needs and would otherwise
be copied: the six-pass PBKDF2 chain, session token minting and hashing, and the
failed-attempt lockout.

They move to `worker/src/credentials.ts`, and both `auth.ts` and the new
`staff-auth.ts` import them. `totp.ts`, `throttle.ts` and `pwned.ts` are already
separate modules and are reused as they are.

This is not opportunistic refactoring. Adding four hundred lines of staff
authentication to `auth.ts` would produce one oversized file serving two systems
with different rules, which is exactly the shape the tenancy design rejected
when it refused to put staff in the `users` table.

## Section 3 — registration, approval, and TOTP as a gate

```
POST /api/staff/register    merchants(status='pending') + staff(scope='merchant', role='owner')
                            body is name, email, password - NO slug
                            slug is minted as pending_<random>, replaced at approval
                            password checked against HIBP's range API - keyless,
                            already implemented in pwned.ts
                            no TOTP secret yet

platform approves           assigns the real slug, status → 'active'

first sign-in               password correct, but totp_confirmed_at is NULL
                            → a restricted session that can do exactly one thing:
                              enrol TOTP
                            → a full session is issued only after a code verifies
```

### The applicant does not choose the storefront address

Registration originally took a slug. A review found that this leaks, and that no
local change to the registration function closes it:

```
probe twice with one throwaway slug
  target IS registered   → 202 (nothing created), then 202   the slug stays free
  target NOT registered  → 202 (merchant created), then 409  the slug is now taken
```

The identical bodies and identical statuses are intact in both rows. What leaks
is not the answer — it is the **side effect**. A successful registration consumes
a globally unique, publicly probeable resource, and that consumption is readable
by anyone who can try to consume it too.

A leak of that shape cannot be patched where it is observed. It closes only by
changing what the operation consumes, so registration no longer takes a slug at
all: one is minted as `pending_<random>` and the platform assigns the real
storefront address when it approves. An attacker cannot collide with a value
they cannot choose.

It is also the more honest model. A marketplace decides what address a seller
gets; letting an applicant reserve `apple` before anyone has looked at their
application was never right.

**TOTP is a gate, not a setting.** An account that can change prices, read
orders and list or delist products is worth more than a customer account, so it
gets a higher bar rather than the same one. There is no "remind me later".

The restricted session is a distinct *type*, not a flag anyone has to remember
to read. `staffSession()` returns a discriminated union:

```ts
type StaffSession =
  | { kind: 'enrolling'; staffId: string }
  | { kind: 'active'; staffId: string; merchantId: string | null; scope: 'merchant' | 'platform' }
```

Only the `active` branch carries a `merchantId`, so `scopedTo` cannot be called
with an enrolling session — not because a check refuses it, but because there is
no argument to pass. A boolean on one session object would be one forgotten
`if` away from a merchant acting without a second factor; this is the same
"make the dangerous state unrepresentable" move as the `staff` table's paired
CHECK, applied to a type instead of a column.

The `totp_pending` column is how the row remembers which it is across requests.

## Section 4 — `merchants.status` has to actually refuse

`tenancy.ts` never reads `merchants.status`. The `pending|active|suspended`
CHECK written in `0006` is decoration today, because there was no sign-in path
and therefore no question to answer.

This plan makes the question reachable, and the default answer is wrong: a
pending or suspended merchant's staff would have full access to their own data.
`scopedTo` gains a status check and refuses anything that is not `active`.

That generalises into a rule worth keeping: **a new entry point wakes up every
dormant field it touches, and their defaults were written in a world where
nothing could reach them.** Those defaults tend to be permissive, because in
that world they were also unobservable.

## Section 5 — the write API

```
POST   /api/merchant/products         → scopedTo(...).products.create
PATCH  /api/merchant/products/:id     → scopedTo(...).products.update
GET    /api/merchant/products         → scopedTo(...).products.list
GET    /api/platform/merchants        → platformWide(...)  pending applications
POST   /api/platform/merchants/:id/approve
```

Every route goes through one of the tenancy core's two existing doors. No third
door. Audit logging needs no work here — it already wraps the repository, so a
platform read of merchant data and every write by anyone land in `audit_log`
without a route knowing about it.

`rating` and `review_count` are absent from `ProductPatch` and stay absent. A
seller who can set their own rating makes the platform not a platform.

## Section 6 — a second worker, not a second route prefix

The console is `nexus-console`, deployed separately from `nexus-api`, on its own
origin, with `SameSite=Strict` cookies.

It is **not** a second directory. `worker/` gains a second entry point and a
second config:

```
worker/wrangler.toml          nexus-api       main = src/index.ts
worker/wrangler.console.toml  nexus-console   main = src/console.ts
```

One `node_modules`, one `tsconfig`, and `tenancy.ts`, `credentials.ts` and the
rest are ordinary imports rather than a cross-project path. Deployed with
`wrangler deploy -c wrangler.console.toml`.

Why a separate worker at all, when this plan ships no UI: moving an
authentication surface between origins later means changing the cookie domain,
which invalidates every staff session and drags the origin allow-list, CORS
config and deploy scripts with it. The cost of starting in the right place is
one config file. The cost of moving is a migration nobody wants to schedule.

Same-origin also earns something the storefront cannot have: the console serves
its own SPA in plan ③, so the browser's own origin policy becomes part of the
isolation chain rather than something CORS has to re-permit.

## Section 7 — what the tests have to prove

Three properties, in descending order of how badly a failure would hurt:

1. **A request cannot choose its own tenant.** Seed two merchants, sign in as
   one, and attempt every merchant route with the other's ids in the path and
   the body. The tenancy core's poisoned-tenant sweep already proves the
   repository holds; this proves the route layer never hands it the wrong scope.
2. **A pending or suspended merchant is refused**, at the repository, not at the
   route — so a route added later inherits it.
3. **A session without a confirmed TOTP can only enrol TOTP.** Assert the
   restricted session is rejected by every other route, rather than asserting a
   flag is set.

Plus the ordinary ones: registration rejects a breached password, lockout
engages, a wrong TOTP code does not consume a session.

## Section 8 — not in this plan

The console SPA, email verification, password reset, recovery codes, merchant
staff beyond the single owner, order reads, and anything that changes
`display_order`.

## What comes next

Plan ③ adds the SPA to `nexus-console` and the README gains its second
user-facing URL. Production catch-up remains a separate piece of work with its
own ordering constraints — `worker/migrations/README.md` holds them.
