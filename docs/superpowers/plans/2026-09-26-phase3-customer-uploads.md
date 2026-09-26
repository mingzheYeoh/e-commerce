# Phase 3 — Customer Uploads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shoppers can set an avatar, review products they received, and ask for a return on a delivered part; merchants handle returns (refunding through the existing refund path) and see their reviews; the platform moderates reviews and reads returns.

**Architecture:** One migration (0016). Photo keys, caps and URL building extend `worker/src/photos.ts`. Customer-side logic (session-scoped, not tenant-scoped) lives in a new `worker/src/uploads.ts` called from `worker/src/index.ts`. Staff-side logic is new repository groups in `worker/src/tenancy.ts` (`reviews`, `returns`, platform-only `moderation`), reached only through `scopedTo` / `platformWide`, routed in `worker/src/console.ts`. Return approval reuses the refund path by extracting `refunds.create`'s batch statements into one helper both call, ending in the same `refundCapGuard`.

**Tech Stack:** Cloudflare Workers, D1 (SQLite), R2, Vue 3 + Pinia + vue-router, Vitest (+ node:sqlite memory D1, Map-backed R2).

## Global Constraints

- Photos are resized in the browser to webp (`console/src/photos.ts` `toWebp`, imported by the storefront too, not copied). The worker checks webp magic bytes and a content-length cap and mints every key; clients never choose a key.
- Public customer photos go in bucket binding `MEDIA` at `avatars/<userId>/<name>.webp` and `reviews/<reviewId>/<name>-1600.webp|-400.webp`, served by API `/media/u/<key>` (so the URL path is `/media/u/avatars/...`), `isPhotoKey` widened to exactly these shapes. URLs are `MEDIA_BASE + key`; `MEDIA_BASE` is added to `worker/wrangler.toml` with the console's values (prod `https://nexus-api.mingzhe030228.workers.dev/media/u/`, staging `https://nexus-api-staging.mingzhe030228.workers.dev/media/u/`).
- Return photos go in a new binding `PRIVATE` (bucket `nexus-private`, staging `nexus-private-staging`) in both wrangler files, key `returns/<returnId>/<name>.webp`, served only to the owner (API), the part's merchant or a platform admin (console), `Cache-Control: private, no-store`.
- Avatar: 256 px, cap 100 KB. Review: rating 1–5, text ≤ 1000 chars sanitised by `clean()`, ≤ 3 photos (1600 + 400, product caps). Return: reason in {damaged, wrong_item, not_as_described, changed_mind, other}, note ≤ 1000, ≤ 3 photos, within 30 days of `delivered_at`, one open request per (order, merchant) part.
- Reviews never reach Vectorize or the agent (nothing in `indexing.ts`, `rag.ts`, `tools.ts`, `agent.ts` changes).
- Every new repository method has a CASES entry in `tenancy.spec.ts`; approve/reject are SELF_AUDITED; platform hide/unhide is audited by the wrapper.
- Do not touch `orders.ts`, checkout, or the order list in `AccountPage.vue` (phase 2). OrderPage/AccountPage get one mounted component each.
- No remote migrations, no deploys, no bucket creation.

## File Structure

| File | Responsibility |
|---|---|
| `worker/migrations/0016-customer-uploads.sql` (new) | schema |
| `worker/schema.sql` | 0016 appended verbatim (test harness schema) |
| `worker/src/photos.ts` | + avatar/review/return key minting, `isPhotoKey` widened, `isReturnKey`, caps, URL helpers |
| `worker/src/text.ts` (new) | `clean` / `text` moved out of console.ts so the API worker can use them |
| `worker/src/uploads.ts` (new) | customer: avatar, reviews CRUD + public list, returns create/list/photos |
| `worker/src/index.ts` | customer routes, `MEDIA_BASE`/`PRIVATE` env, DELETE in CORS, avatar on `/api/auth/me`, R2 cleanup on account delete |
| `worker/src/tenancy.ts` | `reviews`, `returns`, `moderation` groups; `refundWrites` extracted; `stats.queue` + `returns_open` |
| `worker/src/console.ts` | merchant/platform returns + reviews routes, return-photo route |
| `worker/wrangler.toml`, `worker/wrangler.console.toml` | `MEDIA_BASE` var (API), `PRIVATE` bucket (both, both envs) |
| `src/lib/api.ts` | export `BASE`; `Account.avatarUrl` |
| `src/lib/uploads.ts` (new) | storefront client for the new routes |
| `src/components/account/AvatarEditor.vue` (new) | mounted in AccountPage |
| `src/components/commerce/ProductReviews.vue` (new) | mounted in ProductPage |
| `src/components/account/OrderReturns.vue` (new) | mounted in OrderPage |
| `src/components/layout/NavBar.vue` | avatar in header |
| `console/src/api.ts` | returns / reviews client, queue `returnsOpen` |
| `console/src/pages/Returns.vue`, `ReturnDetail.vue`, `Reviews.vue` (new) | scope-aware (merchant / platform) |
| `console/src/router.ts`, `console/src/components/DashboardLayout.vue` | routes, nav, returns badge |

---

### Task 1: Migration 0016 and the test schema

**Files:** Create `worker/migrations/0016-customer-uploads.sql`; modify `worker/schema.sql` (append), `worker/migrations/README.md` (Pending, table row); test `worker/src/tenancy.spec.ts`.

- [ ] Step 1: failing tests in `tenancy.spec.ts` "the migration and the schema": `keeps 0016 and its block in schema.sql identical` (same shape as the 0014 test), and in "the schema refuses states that must not exist": a second open return for one part is refused (UNIQUE), a rejected return without a note is refused (CHECK), a rating of 6 is refused, a second review by one user for one product is refused, deleting a user deletes their reviews and review photos (CASCADE).
- [ ] Step 2: run `npx vitest run worker/src/tenancy.spec.ts` → FAIL (file missing).
- [ ] Step 3: write the migration:

```sql
ALTER TABLE users ADD COLUMN avatar_key TEXT;

CREATE TABLE IF NOT EXISTS reviews (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id  TEXT NOT NULL REFERENCES products(id),
  merchant_id TEXT NOT NULL,
  rating      INTEGER NOT NULL CHECK (typeof(rating) = 'integer' AND rating BETWEEN 1 AND 5),
  body        TEXT NOT NULL DEFAULT '' CHECK (length(body) <= 1000),
  hidden      INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, product_id)
);
CREATE INDEX IF NOT EXISTS reviews_product_idx ON reviews(product_id, hidden, created_at DESC);
CREATE INDEX IF NOT EXISTS reviews_merchant_idx ON reviews(merchant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS review_photos (
  review_id  TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (review_id, name)
);

CREATE TABLE IF NOT EXISTS return_requests (
  id            TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL,
  merchant_id   TEXT NOT NULL,
  reason        TEXT NOT NULL CHECK (reason IN ('damaged','wrong_item','not_as_described','changed_mind','other')),
  note          TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 1000),
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','approved','rejected')),
  refund_minor  INTEGER CHECK (refund_minor IS NULL OR (typeof(refund_minor) = 'integer' AND refund_minor > 0)),
  decision_note TEXT CHECK (decision_note IS NULL OR length(decision_note) <= 1000),
  decided_by    TEXT,
  decided_at    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (status = 'open' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK (status <> 'approved' OR refund_minor IS NOT NULL),
  CHECK (status <> 'rejected' OR length(decision_note) > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS return_requests_open_idx ON return_requests(order_id, merchant_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS return_requests_merchant_idx ON return_requests(merchant_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS return_photos (
  return_id  TEXT NOT NULL REFERENCES return_requests(id),
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (return_id, name)
);
```

  (Plus comments; no semicolons or trigger keywords in comments — d1-memory splits on `;`.) Append verbatim to `schema.sql` under a `-- ---- 0016` header. README: Pending lists 0016 (additive, apply before the workers, staging first), the two new buckets, and the new API var.
- [ ] Step 4: tests pass. Step 5: commit `feat(db): 0016 customer uploads`.

### Task 2: photos.ts keys, caps and URLs; text.ts

**Files:** modify `worker/src/photos.ts`, `worker/src/photos.spec.ts`; create `worker/src/text.ts`; modify `worker/src/console.ts` (import `clean`, `text` from `./text`).

**Produces:**
```ts
export const MAX_AVATAR_BYTES = 100_000
export const MAX_REVIEW_PHOTOS = 3
export const MAX_RETURN_PHOTOS = 3
export const avatarKey = (userId: string, name: string) => `avatars/${userId}/${name}.webp`
export const reviewKey = (reviewId: string, name: string, size: 1600 | 400) => `reviews/${reviewId}/${name}-${size}.webp`
export const returnKey = (returnId: string, name: string) => `returns/${returnId}/${name}.webp`
export const isPhotoKey(key)   // products | avatars/usr_… | reviews/rev_…
export const isReturnKey(key): { returnId: string; name: string } | null
export const reviewPhotoUrls = (base: string, reviewId: string, name: string) => ({ large, thumb })
// text.ts
export const clean = (v: string) => string
export const text = (v: unknown, max: number) => string | null
```

- [ ] Step 1: failing tests: each minted key passes `isPhotoKey`; `returns/...` does NOT pass `isPhotoKey` (never publicly served) and does pass `isReturnKey`; traversal/odd shapes (`avatars/usr_a/../x.webp`, `reviews/rev_a/ph_b.webp`, `avatars/mch_a/ph_b.webp`) are refused.
- [ ] Step 2–4: implement, pass. Step 5: commit.

### Task 3: Tenancy — refund path extracted, returns and reviews groups

**Files:** modify `worker/src/tenancy.ts`, `worker/src/tenancy.spec.ts`.

**Produces (on `Repository`):**
```ts
reviews: { list(filter: { limit?: number }): Promise<ReviewRow[]> }        // READ, newest first, each has merchant_id
returns: {
  list(filter: { status?: ReturnStatus }): Promise<ReturnSummary[]>          // READ
  get(id: string): Promise<ReturnDetail | null>                              // READ; lines, refundable, photo names
  approve(id: string, input: { amountMinor: number; note: string }): Promise<ReturnSummary | null>  // SELF_AUDITED, merchant only
  reject(id: string, input: { note: string }): Promise<ReturnSummary | null>                         // SELF_AUDITED, merchant only
}
stats.queue() → Queue & { returns_open: number }
```
**On `PlatformRepository`:** `moderation: { hide(reviewId), unhide(reviewId) }: Promise<{ id; merchant_id; hidden: boolean } | null>` (wrapper-audited platform writes).

Approve: read request (tenant clause), refuse non-open (Conflict), read the part's lines with remainders, refuse amount over the sum (Conflict, message "Only X is left to refund on this part."), allocate the amount across lines in order, then one batch: conditional UPDATE → audit `returns.approve` `WHERE changes() = 1` → for each allocation `refundWrites(..., onlyIf = auditId)` → `refundCapGuard`. `overCap` → Conflict. `refunds.create` is rewritten to use the same `refundWrites`.

- [ ] Step 1: failing tests: CASES entries for the six new methods (isolation: A cannot list/get/approve/reject B's returns or see B's reviews; completeness passes), PLATFORM_ONLY += moderation.*, MERCHANT_ACTS += returns.approve/reject, SELF_AUDITED list += both; approve writes refunds (qty 0, reason names the return) and the return row together; over-remainder refused and nothing written; a second approve is a Conflict; reject needs a note; a race lost to a direct refund rolls back everything (guard); hide/unhide audited with the merchant id.
- [ ] Steps 2–4, Step 5: commit.

### Task 4: Customer uploads module and API routes

**Files:** create `worker/src/uploads.ts`, `worker/src/uploads.spec.ts` (node environment); modify `worker/src/index.ts`, `worker/src/index.spec.ts` where route-level.

**Routes (API worker):**
- `POST /api/account/avatar` (form `photo`), `DELETE /api/account/avatar`
- `GET /api/auth/me` → user gains `avatarUrl`
- `GET /api/products/:id/reviews?page=N` → `{ average, count, page, next, reviews, viewer }`
- `POST /api/products/:id/review` `{ rating, body }` (create or edit own), `DELETE /api/products/:id/review`
- `POST /api/products/:id/review/photos` (form `large`,`thumb`), `DELETE /api/products/:id/review/photos/:name`
- `GET /api/account/orders/:id/returns`, `POST /api/account/orders/:id/returns` `{ merchantId, reason, note }`
- `POST /api/account/returns/:id/photos` (form `photo`)
- `GET /api/account/return-photos/<key>` (owner only, `private, no-store`)

- [ ] Step 1: failing tests (through `worker.fetch`): avatar replace deletes the old object; non-webp 415; >100 KB 413; review refused (403) until the line's part is delivered; one review per user/product (second POST edits); text cleaned; 4th photo refused; hidden reviews excluded from list and average; author shown as "Ada L."; return refused before delivery / after 30 days / for someone else's order; second open request 409; return photo stored in PRIVATE not MEDIA; photo route 404 for another account, `private, no-store` for the owner; account deletion removes avatar and review photo objects.
- [ ] Steps 2–4, Step 5: commit.

### Task 5: Console routes

**Files:** modify `worker/src/console.ts`, `worker/src/console.spec.ts`.

Routes: `GET /api/merchant/returns?status=`, `GET /api/merchant/returns/:id`, `POST /api/merchant/returns/:id/(approve|reject)`, `GET /api/merchant/return-photos/<key>`, `GET /api/merchant/reviews`, `GET /api/platform/returns`, `GET /api/platform/returns/:id`, `GET /api/platform/return-photos/<key>`, `GET /api/platform/reviews`, `POST /api/platform/reviews/:id/(hide|unhide)`; queue answers `returnsOpen`.

- [ ] Step 1: failing tests: added to MERCHANT_ROUTES / PLATFORM_ROUTES tables (401/403 sweeps); approve 201 with refund; photo served with `private, no-store` to the merchant and platform, 404 to another merchant.
- [ ] Steps 2–4, Step 5: commit.

### Task 6: Wrangler bindings

**Files:** `worker/wrangler.toml` (MEDIA_BASE var both envs, PRIVATE bucket both envs), `worker/wrangler.console.toml` (PRIVATE bucket both envs). Checked by a spec that reads the toml text (every env binds PRIVATE with the right bucket; API MEDIA_BASE equals console MEDIA_BASE per env). Commit.

### Task 7: Storefront UI

**Files:** `src/lib/api.ts` (export BASE, `avatarUrl`), `src/lib/uploads.ts`, `AvatarEditor.vue`, `ProductReviews.vue`, `OrderReturns.vue`, one line each in `AccountPage.vue`, `ProductPage.vue`, `OrderPage.vue`, avatar in `NavBar.vue`. Test: `src/components/commerce/ProductReviews.spec.ts` (renders average, author, photos; form only when eligible) and `src/components/account/OrderReturns.spec.ts` (request button only on eligible parts, outcome shown). Commit.

### Task 8: Console UI

**Files:** `console/src/api.ts`, `Returns.vue`, `ReturnDetail.vue`, `Reviews.vue`, router, DashboardLayout (nav + returns badge). Tests: `console/src/pages/Returns.spec.ts` (approve posts amount, reject requires note, platform view has no buttons), router redirect test for `/returns`. Commit.

### Task 9: Gates and push

`npx vitest run`, `cd worker && npx vitest run`, `npm run typecheck`, `npm run build`, `npm run build:console`; restore `src/data/products.ts` if CRLF-only diff; `git push -u origin feat/customer-uploads`.
