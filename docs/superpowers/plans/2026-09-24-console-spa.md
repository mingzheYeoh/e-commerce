# Console SPA — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A minimal, demo-ready merchant console: merchants apply, sign in, enrol TOTP and manage their products; platform staff approve applications.

**Architecture:** A small Vue 3 app in `console/`, built by a second Vite config that reuses the root `node_modules`, and served as static assets by the existing `nexus-console` worker. Same origin as its API, so the `SameSite=Strict` staff cookie just works and no CORS is needed. All security lives in the worker; the SPA is presentation and routing only.

**Tech Stack:** Vue 3 `<script setup>` + TypeScript, vue-router 4, Tailwind (the storefront's tokens), Vite, Vitest. One new dependency: `qrcode`.

## Global Constraints

- **The SPA enforces nothing.** Every refusal it shows is a refusal the worker already made. A route guard exists for UX — never as the only thing between a user and data.
- API calls are same-origin relative paths (`/api/staff/...`, `/api/merchant/...`, `/api/platform/...`). No base URL, no CORS, no credentials in `localStorage`.
- `rating` and `review_count` are never shown as editable.
- Money is integer minor units. The form converts a typed price to minor units once, at submit; display divides once, in one formatter.
- Visual language matches the storefront: reuse its Tailwind colour tokens and type scale so the two sites read as one product. Dark palette.
- `npm run typecheck` must exit 0 (extend it to cover `console/`), never via `as unknown as` or `any`.
- Deploy to **staging only**. Production is not touched.
- Do not merge to `main`.

## What the worker already serves (Task 6, verified against `worker/src/console.ts`)

```
GET   /api/health
GET   /api/staff/me              { kind: null }
                                 { kind: 'enrolling' }
                                 { kind: 'active', scope: 'platform' }
                                 { kind: 'active', scope: 'merchant', merchant: { name, slug, status } }
POST  /api/staff/register        { name, email, password }  -> 202 always (by design)
POST  /api/staff/signin          sets the staff cookie
POST  /api/staff/totp/begin      -> { secret, uri }
POST  /api/staff/totp/confirm    { code }
POST  /api/staff/signout
GET   /api/merchant/products
POST  /api/merchant/products
PATCH /api/merchant/products/:id
GET   /api/platform/merchants    pending applications
POST  /api/platform/merchants/:id/approve   { slug }
```

If there is no single-product GET, the edit page loads the list and picks by id rather than adding a route.

**The worker refuses any non-GET whose `Origin` is not its own origin.** The storefront and console are sibling `workers.dev` subdomains, so they are the same *site* and `SameSite=Strict` does not keep the staff cookie off storefront-originated requests; the Origin check is what does. Consequence for development: a Vite dev proxy sends `Origin: http://localhost:5173` and every POST gets a 403. Develop through `wrangler dev` serving the built SPA, or make the proxy rewrite `Origin` to the worker's own — say which in the report.

Deploy: `npm run deploy:console:staging` already exists (`npx --prefix worker wrangler deploy -c worker/wrangler.console.toml --env staging`).

## File Structure

| Path | Responsibility |
|---|---|
| `console/index.html`, `console/src/main.ts`, `console/src/App.vue` | App shell |
| `console/src/api.ts` | Typed fetch helpers for every route the worker serves |
| `console/src/router.ts` | Routes and the session-aware guard |
| `console/src/pages/*.vue` | One file per page |
| `vite.console.config.ts` | Builds `console/` → `console/dist`, reusing root deps |
| `worker/wrangler.console.toml` | Gains `[assets]`, with `/api/*` routed to the worker first |
| `scripts/seed-platform-admin.mjs` | One-off: creates the first platform admin from a password read on stdin |

---

### Task A: The shell, the auth flow, and serving it

**Deliverable:** on staging, a visitor can apply, a seeded admin can sign in and is forced through TOTP enrolment, and nothing else is reachable until they do.

- Scaffold `console/` and `vite.console.config.ts` (root `console`, out `console/dist`). Add `build:console` to `package.json`. Add `console/**` to the Tailwind `content` globs. Extend `npm run typecheck` to cover `console/`.
- `worker/wrangler.console.toml`: add `[assets] directory = "../console/dist"`, `not_found_handling = "single-page-application"`, and **`run_worker_first = ["/api/*"]`** — without it the SPA fallback answers `/api/*` with `index.html` and every API call breaks. Repeat under `[env.staging]`: wrangler does not inherit.
- Pages: `/apply` (name, email, password), `/signin`, `/enrol` (QR from the `uri`, plus the secret as text for apps that cannot scan, plus the 6-digit field), `/verify` (6-digit field for an already-enrolled account).
- Router guard, driven by `GET /api/staff/me`:
  - `kind: null` → `/signin` (except `/apply` and `/signin`)
  - `kind: 'enrolling'` → `/enrol` or `/verify` only
  - `kind: 'active', scope: 'merchant'` → `/products`
  - `kind: 'active', scope: 'platform'` → `/applications`
- `/apply` success copy says plainly that the application goes to review and that they will know they are approved when sign-in works — there is no email, by design.
- Tests: the guard's routing table for each `me` shape. Keep it small; the worker's tests carry the security.
- Add `deploy:console:staging` if Task 6 did not.

### Task B: The merchant and platform pages

**Deliverable:** a signed-in merchant lists, creates and edits their own products; a signed-in platform admin approves a pending application with a slug.

- `/products`: table of the merchant's products — title, price, stock, status. Empty state for a new merchant.
- `/products/new` and `/products/:id`: title, price, stock, status (draft / published / archived). Price typed in major units, converted to minor units once at submit. Show the worker's error message on refusal rather than inventing one.
- `/applications`: pending merchants with name and email; a slug field and an Approve button per row; show the worker's 409 message when a slug is taken.
- A header with the merchant's name (from `/me`) and Sign out.

### Task C: Seed the first admin, deploy, document

**Deliverable:** two working URLs in the README.

- `scripts/seed-platform-admin.mjs <email> <db>`: reads the password from **stdin** (never argv, never echoed, never logged), rejects one under 12 characters or found by `tooCommon`, derives it with `credentials.ts`, writes one `staff` row (`scope = 'platform'`, `role = 'admin'`, `merchant_id` NULL) through a temporary `.sql` file applied with `wrangler d1 execute --file`, then deletes the file. The admin still enrols TOTP on first sign-in — the gate applies to them too.
- **The user runs the seed script themselves**; the password must never pass through a conversation. Document the exact command, piping from a prompt that does not echo.
- Build and deploy the console to staging; apply the order: worker config with assets, then verify `/api/staff/me` and the SPA both answer.
- README: a "Try it" section with the storefront URL and the console URL, and a short demo script — apply as a merchant, approve as platform, sign in as the merchant, add a product.

## Deferred, deliberately

Route-layer isolation sweep (old Task 7), both timing residuals, TOTP code reuse within its window, password reset, merchant staff beyond the owner, order views in the console.
