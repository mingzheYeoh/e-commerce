# NEXUS Homepage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the single-page NEXUS // TECH COLLECTIVE electronics storefront homepage — 7 modules, cyber-industrial aesthetic, real downloaded product photography, working cart drawer.

**Architecture:** Vue 3 SFCs composed into one scrolling page. Three Pinia stores hold all state (`cart` is the only one with real logic and the only one tested). Motion is centralised in two composables so `prefers-reduced-motion` can disable everything from one place. Media is downloaded to `public/media/` by a standalone Node script before any UI work, so no component is ever built against a placeholder.

**Tech Stack:** Vue 3 + TypeScript + Vite 7, Tailwind 3.4, Pinia, GSAP/ScrollTrigger, Lenis, lucide-vue-next, Vitest, sharp (build-time only).

## Global Constraints

- Tailwind **v3.4.x** — not v4. Tokens live in `tailwind.config.js` `theme.extend.colors`.
- Colors, verbatim: `void #050505`, `surface-1 #0D0D0E`, `surface-2 #161618`, `border-hairline rgba(255,255,255,0.08)`, `accent-cyan #00F0FF`, `accent-amber #FF5500`, `accent-neon #39FF14`, `text-primary #F5F5F7`, `text-secondary #8E8E93`, `text-muted #48484A`.
- Fonts: display `Syne`, body `Inter`, mono `JetBrains Mono`. All via Google Fonts `display=swap`.
- **No hotlinked media.** Every image and video is served from `public/media/`. `assets.mixkit.co` (403) and `cdn.coverr.co` (404) are dead — never reference them.
- UI copy is English, cyber-industrial register. No i18n.
- Money is computed in **integer cents**. Never multiply or add float dollars.
- `prefers-reduced-motion: reduce` must disable Lenis and every GSAP timeline.
- Every icon-only button needs `aria-label`. Stock and price state must carry a text label, never colour alone.
- Commit after every task.

---

### Task 1: Scaffold + design tokens

**Files:**
- Create: `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `tailwind.config.js`, `postcss.config.js`, `.gitignore`
- Create: `src/main.ts`, `src/App.vue`, `src/assets/css/main.css`

**Interfaces:**
- Produces: npm scripts `dev`, `build`, `preview`, `test`, `assets`. Tailwind token classes (`bg-void`, `text-accent-cyan`, `border-border-hairline`, `font-display`, `font-mono`) usable by every later task.

- [ ] **Step 1: Scaffold Vite + Vue + TS**

```bash
npm create vite@latest . -- --template vue-ts
npm install
npm install pinia gsap lenis lucide-vue-next
npm install -D tailwindcss@^3.4 postcss autoprefixer vitest @vue/test-utils jsdom sharp
```

- [ ] **Step 2: Write `tailwind.config.js`**

```js
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,js,ts}'],
  theme: {
    extend: {
      colors: {
        void: '#050505',
        'surface-1': '#0D0D0E',
        'surface-2': '#161618',
        'border-hairline': 'rgba(255, 255, 255, 0.08)',
        'accent-cyan': '#00F0FF',
        'accent-amber': '#FF5500',
        'accent-neon': '#39FF14',
        'text-primary': '#F5F5F7',
        'text-secondary': '#8E8E93',
        'text-muted': '#48484A',
      },
      fontFamily: {
        display: ['Syne', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
}
```

- [ ] **Step 3: `src/assets/css/main.css`**

Tailwind base/components/utilities layers, `html { background:#050505; color-scheme: dark }`, and a reduced-motion block:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: .01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .01ms !important;
    scroll-behavior: auto !important;
  }
}
```

- [ ] **Step 4: `index.html`** — `<html lang="en">`, Google Fonts preconnect plus Syne/Inter/JetBrains Mono stylesheet link with `display=swap`, `<title>NEXUS // TECH COLLECTIVE</title>`, meta description.

- [ ] **Step 5: `src/main.ts`** — `createApp(App).use(createPinia()).mount('#app')`, importing `./assets/css/main.css`.

- [ ] **Step 6: Verify**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "chore: scaffold vite+vue+ts with design tokens"
```

---

### Task 2: Asset pipeline

**Files:**
- Create: `scripts/fetch-assets.mjs`
- Create (generated): `public/media/products/*.webp`, `public/media/video/*`, `src/data/credits.json`

**Interfaces:**
- Produces: on-disk media at stable paths `/media/products/<slug>-main.webp`, `-alt.webp`, `-thumb.webp`, and `/media/video/<name>.mp4` with `<name>-poster.webp`. Later tasks reference these paths as string literals in fixtures.
- Produces: `src/data/credits.json` — `Array<{ file: string; photographer: string; profileUrl: string; sourceUrl: string }>`, consumed by `SiteFooter.vue` in Task 11.

- [ ] **Step 1: Write the keyword table**

One entry per product slug, each with a search query tuned to return a clean product shot on a dark surface, e.g. `{ slug: 'op1-field', query: 'synthesizer studio dark' }`. Cover all four categories: audio, peripherals, imaging, computing.

- [ ] **Step 2: Implement search + download**

`GET https://unsplash.com/napi/search/photos?query=<q>&per_page=20&orientation=landscape` with an `Accept: application/json` header. Sort results by `likes` descending, take index 0 for `-main` and index 1 for `-alt`. Download `urls.raw` with `&w=2400&q=90&fm=jpg` appended.

- [ ] **Step 3: Re-encode with sharp**

1600w WebP quality 82 for `-main` and `-alt`; 400w for `-thumb`. Videos come from `videos.pexels.com` and are stored as-is; the poster is the matching Pexels still image.

- [ ] **Step 4: Make it idempotent and fail-soft**

Skip any target file that already exists. Wrap each entry in try/catch — on failure log `SKIP <slug>: <reason>` and continue. A partial run must still exit 0 so `npm run assets` can never block a build.

- [ ] **Step 5: Run it**

Run: `npm run assets`
Expected: three files per product slug under `public/media/products/`; `src/data/credits.json` is non-empty valid JSON.

- [ ] **Step 6: Verify the files are real images, not error pages**

Run: `node -e "import('sharp').then(async s => console.log(await s.default('public/media/products/op1-field-main.webp').metadata()))"`
Expected: `width: 1600`, `format: 'webp'`.

- [ ] **Step 7: Commit** — media is committed so the repo clones and runs offline.

```bash
git add -A && git commit -m "feat: asset pipeline with real licensed product photography"
```

---

### Task 3: Types + fixtures

**Files:**
- Create: `src/types/index.ts`, `src/data/products.ts`, `src/data/brands.ts`, `src/data/categories.ts`, `src/data/flagship.ts`

**Interfaces:**
- Produces: `Product`, `Brand` (from the source spec), plus `Category` and `FlagshipPart`.
- Produces: `products: Product[]` (16 items, 4 per category), `brands: Brand[]` (6), `categories: Category[]` (4), `flagship` object.

- [ ] **Step 1: `src/types/index.ts`**

```ts
export interface Product {
  id: string
  sku: string
  brand: 'TEENAGE_ENGINEERING' | 'NOTHING' | 'DJI' | 'SONY' | 'KEYCHRON' | 'KINETIC'
  title: string
  category: 'audio' | 'peripherals' | 'imaging' | 'computing'
  price: number
  currency: string
  inStock: boolean
  stockCount: number
  badge?: 'NEW_DROP' | 'LIMITED_EDITION' | 'DISCOUNT'
  rating: number
  reviewCount: number
  specsSummary: string[]
  media: { heroImage: string; hoverImage?: string; thumb: string; gallery: string[] }
  colorways: { name: string; hex: string }[]
}

export interface Brand {
  id: string
  name: string
  tagline: string
  productCount: number
  previewImage: string
  accent: string
}

export interface Category {
  id: 'audio' | 'peripherals' | 'imaging' | 'computing'
  label: string
  blurb: string
  productCount: number
  fromPrice: number
  media: { type: 'video' | 'image'; src: string; poster?: string }
  span: 'large' | 'square' | 'wide'
}

export interface FlagshipPart {
  id: string
  label: string
  spec: string
  offset: { x: number; y: number }
  revealAt: number
}
```

> Recorded deviation from the source spec: `media.hoverVideoUrl` becomes `media.hoverImage` per design §5; `Brand.logoSvg` / `previewVideoUrl` become `previewImage` + `accent`.

- [ ] **Step 2: Write the 16 products** with real brand and model names, plausible specs, prices, stock counts, and `media` paths pointing at Task 2 output.

Required for the Task 4 float-drift test: at least one product must carry a non-integer price (e.g. `1299.95`), and at least one must have `stockCount` under 10 so `LOW STOCK` renders in Task 9.

- [ ] **Step 3: Verify types compile**

Run: `npx vue-tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: product catalog types and fixtures"
```

---

### Task 4: Cart store (TDD)

**Files:**
- Create: `src/stores/cart.ts`
- Test: `src/stores/cart.spec.ts`
- Modify: `vite.config.ts` — add `test: { environment: 'jsdom' }`

**Interfaces:**
- Produces: `useCartStore()` — state `items: CartLine[]`, `isOpen: boolean`; getters `count: number`, `subtotalCents: number`; actions `add(product: Product, qty?: number)`, `remove(sku: string)`, `setQty(sku: string, qty: number)`, `open()`, `close()`, `toggle()`.
- `CartLine = { sku: string; title: string; brand: string; thumb: string; unitPriceCents: number; qty: number; stockCount: number }`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useCartStore } from './cart'
import { products } from '../data/products'

const p = products[0]

describe('cart store', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('adds a product as one line', () => {
    const cart = useCartStore()
    cart.add(p)
    expect(cart.items).toHaveLength(1)
    expect(cart.count).toBe(1)
  })

  it('merges the same sku instead of duplicating lines', () => {
    const cart = useCartStore()
    cart.add(p)
    cart.add(p)
    expect(cart.items).toHaveLength(1)
    expect(cart.items[0].qty).toBe(2)
  })

  it('clamps quantity to stockCount', () => {
    const cart = useCartStore()
    cart.add(p, p.stockCount + 50)
    expect(cart.items[0].qty).toBe(p.stockCount)
  })

  it('removes a line when quantity is set to 0', () => {
    const cart = useCartStore()
    cart.add(p)
    cart.setQty(p.sku, 0)
    expect(cart.items).toHaveLength(0)
  })

  it('totals in integer cents with no float drift', () => {
    const cart = useCartStore()
    const a = products.find((x) => !Number.isInteger(x.price))!
    cart.add(a, 3)
    expect(cart.subtotalCents).toBe(Math.round(a.price * 100) * 3)
    expect(Number.isInteger(cart.subtotalCents)).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test`
Expected: FAIL — cannot resolve `./cart`.

- [ ] **Step 3: Implement `src/stores/cart.ts`**

`defineStore('cart', ...)`. `unitPriceCents = Math.round(product.price * 100)` computed once at add time. `setQty` clamps to `[0, stockCount]` and splices the line at 0. `subtotalCents` sums `unitPriceCents * qty`.

- [ ] **Step 4: Run to verify pass**

Run: `npm run test`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: cart store with cent-exact totals and stock clamping"
```

---

### Task 5: Catalog + UI stores, motion composables

**Files:**
- Create: `src/stores/catalog.ts`, `src/stores/ui.ts`
- Create: `src/composables/useReducedMotion.ts`, `src/composables/useLenis.ts`, `src/composables/useCurrency.ts`
- Modify: `src/App.vue`, `src/main.ts`

**Interfaces:**
- `useCatalogStore()` — state `activeFilter: 'all' | 'inStock' | Product['category']`, `sort: 'default' | 'priceDesc'`; getter `visible: Product[]`.
- `useUiStore()` — state `currency: 'USD' | 'EUR' | 'GBP'`, `searchOpen: boolean`, `activeBrand: string | null`.
- `useReducedMotion(): Ref<boolean>` — reactive, backed by `matchMedia('(prefers-reduced-motion: reduce)')` with a `change` listener.
- `useLenis(): void` — called once in `App.vue`. No-op when reduced motion is on. Otherwise instantiates Lenis, drives it from `gsap.ticker`, calls `ScrollTrigger.refresh()` on mount, destroys on unmount.
- `useCurrency()` — `{ format(cents: number): string }` with fixed rates `{ USD: 1, EUR: 0.92, GBP: 0.79 }` and symbols `{ USD: '$', EUR: '€', GBP: '£' }`, output shaped `$1,999.00`.

- [ ] **Step 1: Implement the three composables and two stores.**

- [ ] **Step 2: Wire `useLenis()` into `App.vue`;** register `gsap.registerPlugin(ScrollTrigger)` once in `main.ts`.

- [ ] **Step 3: Verify**

Run: `npx vue-tsc --noEmit`
Expected: exit 0. Then `npm run dev` and confirm inertial scrolling.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: catalog/ui stores and motion composables"
```

---

### Task 6: Module 0 — NavBar + CartDrawer

**Files:**
- Create: `src/components/layout/NavBar.vue`, `src/components/layout/CartDrawer.vue`
- Modify: `src/App.vue`

**Interfaces:**
- Consumes: `useCartStore` (Task 4), `useUiStore` and `useCurrency` (Task 5).
- Produces: nothing other components consume — both mount directly in `App.vue`.

- [ ] **Step 1: NavBar** — `fixed top-0 h-16 z-50 w-full backdrop-blur-md bg-void/80 border-b border-border-hairline`. Left: `NEXUS_//[TECH]` with a `bg-accent-neon animate-pulse` telemetry node. Centre: `[01_BRANDS] [02_CATEGORIES] [03_FLAGSHIP] [04_DROPS]` anchors to section ids. Right: search trigger labelled `⌘K`, currency `<select>` bound to `ui.currency`, bag button showing `BAG (0N)` and the live subtotal via `useCurrency().format`.

- [ ] **Step 2: CartDrawer** — right-side panel translating in from `translate-x-full`, `role="dialog" aria-modal="true" aria-label="Shopping bag"`. Lines show thumb, title, mono price, quantity −/+, remove. Empty state included. Footer shows subtotal and a disabled `CHECKOUT // PHASE_02` button — checkout is honestly out of scope.

- [ ] **Step 3: Search palette** — `⌘K` / `Ctrl+K` (and clicking the search trigger) opens a centred modal bound to `ui.searchOpen`. It filters `products` by title, brand and spec text as you type, showing thumb + title + price rows; Enter adds the highlighted row to the bag, ESC closes. Same focus rules as the drawer.

- [ ] **Step 4: Accessibility** — ESC closes; focus moves into the drawer on open and returns to the bag button on close; `overflow-hidden` on `<body>` while open; Tab cycles within the panel.

- [ ] **Step 5: Verify**

Run: `npm run dev`, click the bag button.
Expected: drawer slides in, ESC closes it, Tab stays inside the panel, console clean.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: cyber-HUD navbar and accessible cart drawer"
```

---

### Task 7: Module 1 — Hero viewport

**Files:**
- Create: `src/components/sections/HeroViewport.vue`, `src/components/fx/VideoBackdrop.vue`, `src/components/fx/ScanlineOverlay.vue`
- Modify: `src/App.vue`

**Interfaces:**
- `VideoBackdrop` props: `src: string`, `poster: string`, `opacity?: number`. Renders `<video autoplay loop muted playsinline preload="none">` on desktop; under `(max-width: 767px)` or reduced motion it renders the poster `<img>` only and never fetches the video.
- `ScanlineOverlay` — no props; `absolute inset-0 pointer-events-none`.

- [ ] **Step 1: Build the hero** per source spec §7 — top telemetry bar, centre headline `FUTURE / MACHINERY.` with the gradient span, subcopy, bottom quick-buy card wired to `cart.add()`, scroll prompt.

- [ ] **Step 2: Grade the video** — `contrast-125 brightness-75 saturate-150 opacity-60`, plus both gradient vignettes and the scanline layer from the source spec.

- [ ] **Step 3: Verify**

Run: `npm run dev`
Expected: video plays muted on loop, hero is exactly 100vh, Quick Buy increments the nav bag counter.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: cinematic hero viewport with graded video backdrop"
```

---

### Task 8: Modules 2 + 3 — Brand matrix and category bento

**Files:**
- Create: `src/components/sections/BrandMatrix.vue`, `src/components/sections/CategoryLaunchpad.vue`
- Modify: `src/App.vue`

**Interfaces:**
- Consumes: `brands`, `categories` (Task 3), `useUiStore().activeBrand`, `useCurrency` (Task 5).

- [ ] **Step 1: BrandMatrix** — CSS-keyframe infinite marquee (duplicated track, `animation: marquee 40s linear infinite`, paused on hover, disabled under reduced motion). Hovering a brand opens a floating preview: image, scanline reveal, and `EXPLORE <BRAND> INVENTORY (N ITEMS) →`.

- [ ] **Step 2: CategoryLaunchpad** — asymmetric bento on `grid-cols-1 md:grid-cols-4`; `large` = `col-span-2 row-span-2`, `square` = `col-span-1`, `wide` = `col-span-2`. Each card carries `N PRODUCTS IN STOCK` and a `FROM $xx` pill.

- [ ] **Step 3: Video cards play only when visible** — `IntersectionObserver` calls `play()` / `pause()`; skipped entirely under reduced motion.

- [ ] **Step 4: Verify**

Run: `npm run dev`
Expected: marquee wraps with no visible gap; bento keeps its asymmetry at ≥768px and stacks below.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: brand marquee and category bento grid"
```

---

### Task 9: Module 5 — Product drop grid

**Files:**
- Create: `src/components/sections/ProductDropGrid.vue`, `src/components/commerce/ProductCard.vue`, `src/components/commerce/FilterChips.vue`, `src/components/commerce/StockBadge.vue`, `src/components/commerce/PriceTag.vue`
- Modify: `src/App.vue`

**Interfaces:**
- `ProductCard` props: `product: Product`. Emits nothing — calls `useCartStore().add()` directly.
- `FilterChips` — writes `catalog.activeFilter` and `catalog.sort`.
- `StockBadge` props: `product: Product` — renders `NEW DROP` (cyan), `LOW STOCK: N LEFT` (amber) or `SOLD OUT`, always as text.
- `PriceTag` props: `cents: number` — mono, formatted through `useCurrency`.

- [ ] **Step 1: Sticky filter bar** — `sticky top-16 z-30`, chips `[ALL ITEMS] [IN STOCK ONLY] [ACOUSTICS] [PERIPHERALS] [IMAGING] [PRICE: HIGH → LOW]`, active chip in cyan.

- [ ] **Step 2: ProductCard** — brand pill, status badge, main image cross-fading to `hoverImage` on hover, title, `specsSummary.join(' // ')`, `★ rating (reviewCount)`, price, and a quick-add icon button with `aria-label="Add <title> to bag"`.

- [ ] **Step 3: Quick-add feedback** — button flashes `ADDED ✓` for 900ms and the nav bag count animates. No page reload.

- [ ] **Step 4: Verify**

Run: `npm run dev`
Expected: every chip changes the visible set; price sort orders high→low; adding from a card updates the drawer.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: filterable product drop grid with quick-add"
```

---

### Task 10: Module 4 — Deconstructed flagship

**Files:**
- Create: `src/components/sections/DeconstructedFlagship.vue`, `src/components/sections/flagship/LayeredRenderer.vue`
- Modify: `src/App.vue`

**Interfaces:**
- `LayeredRenderer` props: `progress: number` (0..1). **This is the swap seam** — a future three.js renderer implements the same single prop and nothing in the shell changes.
- The shell owns: ScrollTrigger pin across 300vh, `progress` state, SVG leader lines, spec callouts, sticky purchase panel.

- [ ] **Step 1: Pin the section**

```ts
ScrollTrigger.create({
  trigger: sectionRef.value,
  start: 'top top',
  end: '+=300%',
  pin: true,
  scrub: 1,
  onUpdate: (self) => { progress.value = self.progress },
})
```

- [ ] **Step 2: LayeredRenderer** — product photo layers translated outward by `progress` along each part's `offset` vector, with depth blur and scale falloff.

- [ ] **Step 3: Leader lines** — each `FlagshipPart` draws its SVG line and `[CORE]` / `[CHASSIS]` / `[ACOUSTICS]` label once `progress >= revealAt` (~0.5), animated via `stroke-dashoffset`.

- [ ] **Step 4: Purchase panel** — variant switcher (Matte Obsidian / Ghost Transparent / Raw Titanium), live price, `PRE-ORDER SPEC_01 // DISPATCH IN 48H` wired to `cart.add()`.

- [ ] **Step 5: Reduced-motion fallback** — no pin, no scrub; render the exploded state statically with every label visible.

- [ ] **Step 6: Verify**

Run: `npm run dev`
Expected: section pins for three viewport heights, parts separate smoothly, labels appear near half progress, and it unpins into the next section with no layout jump.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: scroll-pinned deconstructed flagship showcase"
```

---

### Task 11: Module 6 — Footer, polish, README

**Files:**
- Create: `src/components/layout/SiteFooter.vue`, `README.md`
- Modify: all sections — accessibility and performance pass

**Interfaces:**
- Consumes: `src/data/credits.json` (Task 2) for photo attribution.

- [ ] **Step 1: Footer** — newsletter terminal input `ENTER_EMAIL: _` using native `type="email"` + `required` with an inline validation message and no library, certification badges, live UTC/local clock, `V2.6.4_RELEASE`.

- [ ] **Step 2: Photo credits** — collapsible attribution list rendered from `credits.json`.

- [ ] **Step 3: Accessibility pass** — skip-to-content link, visible `focus-visible` ring in `accent-cyan` on every interactive element, heading order `h1 → h2` with no skips, all `aria-label`s present.

- [ ] **Step 4: Performance pass** — explicit `width` / `height` on all images, `loading="lazy"` everywhere except the hero, `preload="none"` on non-hero video.

- [ ] **Step 5: README** — what it is, screenshot, `npm i && npm run assets && npm run dev`, architecture notes, the documented deviations from the original spec (dead CDNs, video budget, Module 4 approach), and the stock-media licence note.

- [ ] **Step 6: Final verification**

```bash
npm run test && npx vue-tsc --noEmit && npm run build
```

Expected: tests pass, no type errors, build exits 0. Then drive Chrome: screenshot at 1440px and 375px, read the console, confirm zero errors.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: industrial footer, a11y and performance pass, README"
```
