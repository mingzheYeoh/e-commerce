# NEXUSOHM launch: domain, cloud media, order details, Malaysian payments, customer uploads

Approved 2026-09-26. Three phases; phase 1 ships before 2 and 3, which run in parallel.

## Phase 1 — domain, rename, media to R2

### Hostnames (production only; staging stays on workers.dev)

| Host | Worker / resource |
|---|---|
| `nexusohm.com`, `www.nexusohm.com` | `nexus-tech-collective` (storefront) |
| `admin.nexusohm.com` | `nexus-console` |
| `api.nexusohm.com` | `nexus-api` |
| `media.nexusohm.com` | R2 bucket `nexus-media`, public via custom domain |

- Attached with `routes = [{ pattern = "...", custom_domain = true }]` in each wrangler file, and `wrangler r2 bucket domain add` for media. The zone is already in the account.
- `workers_dev` stays on, so every existing link keeps working.
- `ALLOWED_ORIGIN` (API): `https://nexusohm.com` first (it is what `siteUrl` puts in email links), then `https://www.nexusohm.com`, the old workers.dev storefront, localhost.
- The API on `api.nexusohm.com` is same-site with the storefront, so the session cookie is first-party.
- `.env.production` is local and untracked; the owner changes `VITE_API_URL` to `https://api.nexusohm.com` themselves (one `sed` line). It is never read by the agent.

### Rename

`NEXUS` → `NEXUSOHM` in user-visible text: storefront header and footer, `<title>`/meta, console, email bodies and subjects, `MAIL_FROM` display name, README. Code identifiers, table names, worker names and repo name are unchanged.

### Media

- Upload every file under `public/media/**` (245 files, 17 MB) to `nexus-media` at the same path minus `media/` (for example `public/media/products/x.webp` → key `products/x.webp`).
- Verify each upload with a HEAD to `https://media.nexusohm.com/<key>`: status 200, and the same byte length as the local file. Only when all pass is `public/media` deleted from the repo. Git history keeps a copy.
- Rewrite references:
  - `src/data/*.ts`, `credits.json`, `HeroViewport.vue`, `semantic.ts` and anything else a grep finds: `/media/` → `https://media.nexusohm.com/`, through one exported `MEDIA_ORIGIN` constant where code builds URLs.
  - D1 `products.media` (production and staging): the same rewrite, with a count printed before and after.
- Staging reads catalogue images from the same production media host. They are read-only, so there is no second copy.
- Merchant photo uploads keep their current route and `MEDIA_BASE`. Moving them is out of scope, because `namesIn` parses stored URLs against `MEDIA_BASE`, and changing it would orphan every existing photo.
- Private files (return photos, phase 3) go to a **separate** bucket, `nexus-private` / `nexus-private-staging`. Anything in `nexus-media` is public once the custom domain is attached.

## Phase 2 — order details and Malaysian payments

### Order details

- Order page: each line shows thumbnail, title, finish, SKU, unit price, quantity, line total, seller and that seller's fulfilment status. The title links to `/product/<id>`. If the product is no longer published, it shows as plain text marked "no longer available".
- Order-level amounts shown: subtotal, shipping, tax, total (this closes the known limit from the last release).
- Account page: each order row expands inline to its lines, with thumbnails, loaded from the existing order endpoint the first time it is opened.

### Payments (all simulated; nothing leaves the browser that a real gateway would need)

- **Card**
  - Brand detection (Visa / Mastercard / Amex by prefix), Luhn check, expiry not in the past, CVC length by brand.
  - Existing test numbers keep their outcomes.
  - Card data never reaches the server, as now. The server receives only method, brand and last four digits.
- **FPX online banking**
  - A bank list with names only: Maybank2u, CIMB Clicks, Public Bank, RHB Now, Hong Leong Connect, AmOnline, Bank Islam, BSN, Affin, Alliance, UOB, OCBC.
  - Choosing a bank opens an in-app screen titled "NEXUSOHM payment simulator — no real bank is contacted", with Approve / Decline / Time out.
- **E-wallet**
  - Touch 'n Go eWallet, GrabPay, Boost, ShopeePay (names only).
  - The screen shows a locally generated decorative QR code and a 3-minute countdown, with "Simulate paid" and "Cancel". When the countdown ends, the payment times out.
- **No bank or wallet logos, and no imitation of any bank login page.** Methods are plain text with generic icons.
- Server: `orders` gains `payment_method` (`card` | `fpx` | `ewallet`), `payment_channel` (brand or bank/wallet name, validated against a server-side allow-list) and `payment_ref` (for example `SIM-FPX-XXXXXX`, minted by the server).
  - Declined and timed-out attempts are not placed as orders. They behave as the current decline does.
- Console Payments pages show method and channel. The migration defaults existing rows to `card`.

## Phase 3 — customer uploads

Shared: photos are resized in the browser to webp. The worker checks webp magic bytes and a content-length cap, and mints the keys; clients never choose a key. This is the same pipeline as merchant photos (`photos.ts`), extended rather than copied.

Public customer photos (avatars, reviews) are stored in `nexus-media` / `nexus-media-staging` under `u/` and served by the existing API `/media/u/<key>` route, with `isPhotoKey` widened to the `avatars/` and `reviews/` prefixes and URLs built from the same `MEDIA_BASE` value the console uses (added as an API var). This works in staging, whose bucket has no public domain; `media.nexusohm.com` serves the catalogue.

### Avatar

- 256 px webp, cap 100 KB.
- Key: `u/avatars/<userId>/<random>.webp`.
- `users.avatar_key` stores it. Uploading replaces the old one and deletes it from R2. Removing is supported.
- Shown in the header and on the account page.

### Reviews

- Eligibility: a signed-in account that placed an order containing the product, where that line's fulfilment part is `delivered`.
- One review per (user, product); editable and deletable by its author.
- Rating 1–5, text ≤ 1000 characters (sanitised like merchant text), up to 3 photos (1600 px + 400 px thumbs, same caps as product photos).
  - Photos under `u/reviews/<reviewId>/`.
- Product page: average rating and count, list newest first, paginated. The author is shown as first name plus last initial.
- Console: merchants see reviews of their own products (read-only). Platform admins can hide or unhide a review, and that action is audited.
- Reviews are never indexed into Vectorize or given to the AI agent.

### Return requests

- Allowed per fulfilment part whose status is `delivered`, by the account that placed the order, within 30 days of `delivered_at`. One open request per part.
- Fields: reason (fixed list: damaged, wrong item, not as described, changed mind, other), note ≤ 1000 characters, up to 3 photos.
  - Photos go in `nexus-private` and are served only through `GET /api/.../return-photos/:key` to the owner, the part's merchant, or a platform admin. `Cache-Control: private, no-store`.
- States: `open` → `approved` | `rejected`.
  - Approve takes a refund amount ≤ the part's refundable remainder and calls the existing refund path, under the same cap and rollback guard.
  - Reject requires a note.
- Merchant console gets a **Returns** page (queue, detail with photos, approve/reject) and a sidebar count. Platform sees all returns read-only.
- The customer's order page shows the request status and outcome.

### Tenancy

Every new repository method goes through `scopedTo` / `platformWide`, gets a case in the isolation sweep, and is covered by the completeness test.

## Data

One migration per phase:
- `0015`: payment columns on `orders`.
- `0016`: `users.avatar_key`, `reviews`, `review_photos`, `return_requests`, `return_photos`, plus indexes.
- The phase 1 URL rewrite is a data script, not schema.

Each migration file is read before it is applied remotely, and applied staging first, then production.

## Delivery

- Phase 1: done by me directly (infra, secrets-adjacent, needs the owner's `.env.production` edit).
- Phases 2 and 3: one agent each in its own worktree. At most two concurrent agents.
- Each phase: independent review → fix → staging deploy and smoke test → PR to staging → PR to main → production deploy (migration → API → console → storefront).
- Final: an acceptance checklist in Chinese.

## Out of scope

- Real payment gateways.
- Moving merchant photos off `/media/u/`.
- A custom domain for staging.
- Review replies from merchants.
- Return shipping labels.
