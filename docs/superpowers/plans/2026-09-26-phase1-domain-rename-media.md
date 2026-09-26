# Phase 1: nexusohm.com, NEXUSOHM rename, catalogue media on R2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Production answers on nexusohm.com / admin. / api. / media., the brand reads NEXUSOHM, and every catalogue image and video is served from R2 with the local copies deleted.

**Architecture:** Custom domains are attached through wrangler `routes` with `custom_domain = true`, and through `r2 bucket domain add` for media. Catalogue URLs become absolute through one `MEDIA_ORIGIN` constant. A committed manifest records what was uploaded and verified, and the existing media test checks references against it instead of the disk.

**Tech Stack:** Cloudflare Workers, R2 and D1 through wrangler 4 (`worker/node_modules`); Vue 3; vitest.

## Global Constraints

- Staging keeps its workers.dev hosts. Only production gets custom domains.
- `workers_dev` stays enabled on every worker, so old links keep working.
- `.env.production` is never read by the agent. The owner edits `VITE_API_URL` themselves.
- Merchant photo `MEDIA_BASE` is unchanged: `namesIn` parses stored URLs against it.
- `public/media/search/*` is the semantic-search index, not photos. It stays local.
- Local images are deleted only after every upload is HEAD-verified (status 200, same byte length).
- Use `worker/`'s wrangler. After any failed wrangler command, run `git status`.
- Read every SQL file before running it remotely: staging first, then production.

---

### Task 1: Rename to NEXUSOHM

**Files:** `index.html`, `console/index.html`, `src/components/layout/NavBar.vue`, `src/components/layout/SiteFooter.vue`, `console/src/components/DashboardLayout.vue`, `console/src/pages/Apply.vue`, `console/src/pages/SignIn.vue`, `worker/src/mail.ts`, `worker/src/totp.ts`, `worker/src/index.ts`, `worker/wrangler.toml` (`MAIL_FROM` display name), `README.md`, plus any spec asserting the old copy.

- [ ] Step 1: `grep -rn "NEXUS" <files>` and list every user-visible occurrence. Skip identifiers, comments, table names and localStorage keys (`nexus:*` stays, so existing carts survive).
- [ ] Step 2: Replace the visible brand `NEXUS` with `NEXUSOHM`. The TOTP issuer becomes `NEXUSOHM`; existing enrolments keep their old label and their codes keep working.
- [ ] Step 3: Update specs that assert old copy. Run `npx vitest run` at the root and `cd worker && npx vitest run`. Expected: all pass.
- [ ] Step 4: Commit `feat: rename the store to NEXUSOHM`.

### Task 2: Upload catalogue media and write the manifest

**Files:** Create `scripts/upload-media.mjs` and `src/data/media-manifest.json`.

**Produces:** `media-manifest.json` = `{ "origin": "https://media.nexusohm.com", "files": { "<key>": <bytes> } }`.

- [ ] Step 1: The script walks `public/media` and skips `search/`.
  - For each file it runs `npx --prefix worker wrangler r2 object put nexus-media/<key> --file <path> --remote --content-type <type> --cache-control "public, max-age=31536000, immutable"`, with 4 files in parallel.
  - It then HEADs `${origin}/${key}` and compares `content-length` to the file size.
  - It writes the manifest only for verified keys, and exits non-zero listing every failure.
- [ ] Step 2: Attach the domain: `npx wrangler r2 bucket domain add nexus-media --domain media.nexusohm.com --zone-id <owner-supplied>`. Then `curl -sI https://media.nexusohm.com/flagship/flagship.webp` should return 200.
- [ ] Step 3: Run the script. Expected: 246 verified (245 webp + 1 mp4), and 0 failures.
- [ ] Step 4: Commit the script and manifest: `feat: catalogue media uploaded to R2 with a verified manifest`.

### Task 3: Point every reference at R2 and delete local images

**Files:** Create `src/data/media.ts` (`export const MEDIA_ORIGIN = 'https://media.nexusohm.com'`). Modify `src/data/products.ts`, `brands.ts`, `categories.ts`, `flagship.ts`, `src/components/sections/HeroViewport.vue`, `src/data/media.spec.ts`. Delete `public/media/{brands,categories,flagship,products,video}`.

- [ ] Step 1: Rewrite `media.spec.ts` to check against the manifest. Every catalogue URL must start with `MEDIA_ORIGIN + '/'` or be a merchant upload (`/media/u/`), and its key must be in `manifest.files`. Keep the four existing `describe` cases and their comments' intent. Run it: FAIL, because the data still says `/media/`.
- [ ] Step 2: In the data files, replace `'/media/` with `` `${MEDIA_ORIGIN}/ `` (template literal) through a script, not by hand. Do the same in `HeroViewport.vue`. `products.ts` is generated: also change the generator in `scripts/` that emits it, so a rebuild does not revert it.
- [ ] Step 3: Run `npx vitest run src/data`: PASS. Run `npm run build`: succeeds.
- [ ] Step 4: `git rm -r` the five image folders. Run `npx vitest run`: all pass. Run `npm run build` and check that `dist/media` has only `search/`.
- [ ] Step 5: Commit `feat: catalogue served from media.nexusohm.com; local images removed`.

### Task 4: D1 media rewrite

**Files:** Create `worker/scripts/rewrite-media-urls.sql`.

```sql
-- Catalogue photos moved from the storefront's /media/ to R2 on
-- media.nexusohm.com. Merchant uploads (/media/u/ on nexus-api) are absolute
-- already and untouched: they never contain the quoted relative prefix.
UPDATE products SET media = REPLACE(media, '"/media/', '"https://media.nexusohm.com/')
 WHERE media LIKE '%"/media/%';
```

- [ ] Step 1: Before: `SELECT COUNT(*) FROM products WHERE media LIKE '%"/media/%'` on staging, then on production (expected production value: 45).
- [ ] Step 2: Apply to staging, re-count: 0. Load a staging product page and confirm images render.
- [ ] Step 3: Apply to production (after the Task 5 deploy). Re-count: 0.

### Task 5: Custom domains and origins

**Files:** `wrangler.toml` (storefront), `worker/wrangler.toml`, `worker/wrangler.console.toml`, `.env.production` (owner).

- [ ] Step 1: Top-level (production only) `routes` in each file:
  - storefront: `nexusohm.com` and `www.nexusohm.com`
  - API: `api.nexusohm.com`
  - console: `admin.nexusohm.com`
  - Each is `{ pattern = "...", custom_domain = true }`, and each worker gets `workers_dev = true`.
- [ ] Step 2: API `ALLOWED_ORIGIN = "https://nexusohm.com,https://www.nexusohm.com,https://nexus-tech-collective.mingzhe030228.workers.dev,http://localhost:5173"`.
- [ ] Step 3: Check the console and API for any other hard-coded storefront or console URL (`grep -rn "workers.dev" worker/src console/src src`) and update the production ones.
- [ ] Step 4: The owner runs `sed -i 's#^VITE_API_URL=.*#VITE_API_URL=https://api.nexusohm.com#' .env.production`.
- [ ] Step 5: Deploy in order: API → console → storefront. Then:
  - `curl -s https://api.nexusohm.com/api/health` shows `"mail":true`.
  - `https://nexusohm.com` returns 200 with title NEXUSOHM.
  - `https://admin.nexusohm.com/api/merchant/overview` returns 401.
  - `https://nexusohm.com/account` gets a 200 from the SPA.
  - A CORS preflight from `Origin: https://nexusohm.com` to `api.nexusohm.com` echoes that origin.
- [ ] Step 6: Update the README links and the staging/production notes.

### Task 6: Ship

- [ ] Run the full test suites. PR → staging, merge, `npm run deploy:staging` and the API staging deploy. Smoke-test staging images.
- [ ] PR staging → main, merge. Production: Task 5 deploy, then Task 4 step 3.
- [ ] `git checkout -- src/data/products.ts` if a build leaves a CRLF-only diff.
