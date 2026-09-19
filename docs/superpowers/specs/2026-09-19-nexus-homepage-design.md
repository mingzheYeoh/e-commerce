# NEXUS // TECH COLLECTIVE — Homepage Design Spec

- **Date:** 2026-09-19
- **Status:** Approved
- **Source:** User-supplied `FRONTEND_SPEC.md` (7-module cyber-industrial e-commerce homepage)

## 1. Scope

Single-page **Homepage only**. All 7 modules from the source spec. No router, no
additional pages.

- Cart is a **side drawer**, never a separate page.
- **Payment/checkout is out of scope this phase.** A homepage has no checkout
  entry point; a Stripe sandbox here would be a feature with no user. When the
  PDP/checkout pages get built, Stripe **test mode** (`pk_test_` key) is used.
- Purpose is portfolio / technical showcase, so the data layer is **local
  typed fixtures + Pinia**, not a mock async API layer.

## 2. Stack

| Concern | Choice | Reason |
|---|---|---|
| Framework | Vue 3 `<script setup>` + TypeScript | Per source spec |
| Build | Vite 7 | Per source spec |
| Styling | Tailwind **v3.4** | Source spec's arbitrary-value syntax and `tailwind.config.js` token block are v3-shaped. v4 is CSS-first and would require rewriting every token. |
| State | Pinia | `cart`, `catalog`, `ui` |
| Motion | GSAP + ScrollTrigger, `lenis` | Per source spec |
| Icons | `lucide-vue-next` | Per source spec |
| Test | Vitest (cart store only) | The only module with real business logic |

UI copy stays in the English cyber-industrial register (`SYS_STATUS // ONLINE`).
No i18n — translating the aesthetic destroys it.

## 3. Design tokens

Exactly as supplied in the source spec, wired into `tailwind.config.js`:

```
void #050505 / surface-1 #0D0D0E / surface-2 #161618
border-hairline rgba(255,255,255,.08)
accent-cyan #00F0FF / accent-amber #FF5500 / accent-neon #39FF14
text-primary #F5F5F7 / text-secondary #8E8E93 / text-muted #48484A
```

Type: display = Syne (extrabold, uppercase, tracking-tighter); body = Inter;
technical/price/SKU = JetBrains Mono. Loaded from Google Fonts with `display=swap`.

## 4. Asset pipeline (deviation from source spec)

The source spec's three recommended video URLs were **verified dead**:

| Source | Probe result |
|---|---|
| `images.unsplash.com` direct | 200 OK |
| `images.pexels.com` | 200 OK |
| `videos.pexels.com` | 206 OK (range requests supported) |
| `assets.mixkit.co` (3 spec URLs) | **403 hotlink-blocked** |
| `cdn.coverr.co` (spec URL) | **404** |

Therefore: **no hotlinking.** `scripts/fetch-assets.mjs`, run via `npm run assets`:

1. Keyword table (in source) -> Unsplash `napi/search/photos` (public, no API key
   required — verified returning results).
2. Pick highest-liked landscape results per keyword.
3. Download `urls.raw` at high resolution.
4. Re-encode with `sharp` to 1600w WebP + 400w thumbnail into `public/media/`.
5. Write `src/data/credits.json` (photographer name + profile URL + photo URL)
   for footer attribution.

Properties: **idempotent** (existing files skipped), **reproducible** (keyword
table is code), **degrades safely** (on network failure the page falls back to
CSS gradient/noise placeholders — never a black box or broken-image icon).

Licensing: Unsplash and Pexels licenses permit commercial use. Real brand
product photography from manufacturer sites is **not** used — brand names,
model names and specs are written as text; imagery comes from licensed stock.

## 5. Video budget (deviation from source spec)

The source spec places video in the hero, all 4 category cards, 6 brand hover
previews, and every product card hover: 15+ clips, 80MB+, unusable LCP on
mobile. Reduced to:

| Location | Source spec | This design |
|---|---|---|
| Hero backdrop | video | video, with `poster` image; mobile shows poster only |
| Category cards | 4 videos | 2 videos (play only when intersecting) + 2 stills with slow Ken Burns |
| Brand hover preview | video | still image + scanline reveal |
| Product card hover | video | **second angle image**, cross-fade |

*Skipped: video on every surface. Add back when there is a CDN and a transcode pipeline.*

## 6. Structure

```
src/
├─ components/
│  ├─ layout/     NavBar.vue  CartDrawer.vue  SiteFooter.vue
│  ├─ sections/   HeroViewport.vue  BrandMatrix.vue  CategoryLaunchpad.vue
│  │              DeconstructedFlagship.vue  ProductDropGrid.vue
│  ├─ commerce/   ProductCard.vue  QuickAdd.vue  PriceTag.vue
│  │              StockBadge.vue  FilterChips.vue
│  └─ fx/         VideoBackdrop.vue  ScanlineOverlay.vue  MonoLabel.vue
├─ composables/   useLenis.ts  useCurrency.ts  useReducedMotion.ts
├─ data/          products.ts  brands.ts  categories.ts  flagship.ts  credits.json
├─ stores/        cart.ts  catalog.ts  ui.ts
└─ types/index.ts
scripts/fetch-assets.mjs
public/media/{products,brands,video}/
```

`types/index.ts` uses the `Product` and `Brand` interfaces from the source spec verbatim.

## 7. Module 4 — Deconstructed Flagship

The source spec assumes 80–120 pre-rendered explosion frames. Such an asset
sequence cannot be sourced. Decision: **layered version now, 3D later.**

`DeconstructedFlagship.vue` owns only the shell — ScrollTrigger pin (300vh
virtual scroll), scroll progress, SVG leader lines, spec callouts, and the
sticky purchase panel with variant switcher. The visual is rendered by a
separate child renderer component driven by a single `progress: 0..1` prop.

- **Phase 1 renderer:** high-res real product photo, layered elements
  separating along depth axis with parallax, SVG leader lines drawing on at
  ~50% progress, spec numbers counting up.
- **Phase 2 (future):** swap the renderer for a three.js procedural model. The
  shell's props contract (`progress`) does not change.

## 8. Stores

- **`cart`** — items, add/remove/qty, totals, drawer open state. Real logic:
  same-SKU merge, quantity clamped to `stockCount`, **money held as integer
  cents** to avoid float drift. Covered by Vitest.
- **`catalog`** — product fixtures, filtering (category, in-stock-only) and
  sorting (price high→low).
- **`ui`** — currency (USD/EUR/GBP, fixed client-side rates), search modal
  state, active brand filter.

## 9. Non-negotiables

- `prefers-reduced-motion: reduce` disables Lenis and all GSAP timelines; the
  page degrades to native scroll and stays fully usable.
- Cart drawer: focus trap, ESC to close, `aria-modal`, focus returned to trigger.
- Every icon-only button has `aria-label`. Stock/price state is never signalled
  by colour alone — text label always present.
- All images carry explicit `width`/`height` and `loading="lazy"` (except LCP
  hero) to prevent CLS.

## 10. Verification

1. `npm run dev`, then drive Chrome via `claude-in-chrome`: screenshot at
   desktop width and 375px, read console to confirm zero errors.
2. `npm run test` — cart store logic passes.
3. `npm run build` — build succeeds; report bundle size.

## 11. Milestones

| # | Deliverable |
|---|---|
| M1 | Scaffold, Tailwind tokens, fonts, git |
| M2 | Asset script working, real photos on disk (done early so no module is built against placeholders) |
| M3 | Module 0 nav + Module 1 hero + cart drawer |
| M4 | Module 2 brand matrix + Module 3 category bento |
| M5 | Module 5 product grid + filters + quick-add (+ Vitest) |
| M6 | Module 4 scrollytelling (layered renderer) |
| M7 | Module 6 footer + a11y + perf + README |
