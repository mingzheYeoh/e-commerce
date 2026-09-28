# Storefront motion redesign: search palette, homepage grids, three.js hero

Approved 2026-09-28 (scope A + B + C). Ships to staging for the owner's review
before production.

References: Raycast / Linear / Vercel command palettes; Aceternity UI and its
Vue port Inspira UI (spotlight card, moving border, bento grid, 3D tilt);
Awwwards three.js hero scenes.

## Global rules

- Motion respects `<html data-motion>` (useReducedMotion is the writer; the
  `?motion=on` override must keep working). Reduced motion gets a complete,
  good-looking static page — never a half-animated one.
- No new dependency except `three` (part C), loaded by dynamic import in its
  own chunk, never on the critical path.
- Hover effects are pointer-only (`@media (hover: hover)`); touch devices get
  the static card. Effects are driven by CSS custom properties set on
  pointermove, so a grid of 45 cards costs no per-frame JS.
- Keep every existing behaviour and test: keyboard navigation, add-to-cart,
  compare, links, a11y labels, the search palette's `data-lenis-prevent` and
  `overscroll-contain`, and `focus-visible:ring-0` on its bare input.
- Match the dark palette and tokens in `src/assets/css/main.css` and
  `tailwind.config.js`; no new colour system.

## A — Search palette (`src/components/layout/SearchPalette.vue`)

- Larger input (text-base/lg), panel opens with a scale+fade, and a faint
  animated conic-gradient glow around the panel edge.
- Results grouped under headings: **Products**, **Categories**, **Brands**
  (matched from `src/data/categories.ts` / `brands.ts`), then a final row
  **"Ask AI: “<query>”"** that routes to `/ask?q=<query>`. Arrow keys move
  through all rows across groups; Enter opens.
- The selected row has an accent highlight that slides between rows (one
  absolutely positioned indicator), and "Add" shows only on the selected or
  hovered product row.
- Empty state: recent searches (localStorage `nexus:recent-searches`, max 5,
  try/catch around every access), trending query chips, and three popular
  products as small cards.
- Footer hints rendered as keycaps.

## B — Homepage grids

- **CategoryLaunchpad → bento grid**: asymmetric tiles (one large, the rest
  smaller), collapsing to one column on mobile; cursor-following spotlight,
  a moving border on hover, slight image zoom.
- **Product cards** (`ProductCard.vue`, used on home and /shop): spotlight +
  subtle 3D tilt + glare on hover; the add-to-cart action slides up on hover
  while staying reachable by keyboard and on touch.
- **BrandMatrix → marquee**: two rows of brands scrolling in opposite
  directions, pause on hover/focus; brand links and any existing brand
  hover preview keep working. Reduced motion: a static wrapped grid.
- Sections reveal on scroll (stagger), via the existing GSAP ScrollTrigger or
  IntersectionObserver.

## C — three.js hero (`src/components/sections/HeroViewport.vue`)

- A real-time particle network (points + near-neighbour lines, accent blue on
  the void background) that slowly rotates and parallaxes toward the cursor,
  replacing the video backdrop where it runs.
- Falls back to the current video/poster when: reduced motion, no WebGL,
  viewport < 768px, or `navigator.connection.saveData`.
- `import('three')` only after the hero mounts and the browser is idle; DPR
  capped at 1.5; paused when off-screen (IntersectionObserver) or the tab is
  hidden; geometry, materials and renderer disposed on unmount.

## Delivery

- Agent 1: A + C on `feat/search-palette-hero`. Agent 2: B on
  `feat/home-grids`. Each: unit tests for the new logic (grouping, keyboard
  order, recent searches, fallbacks), `npm test`, `npm run typecheck`,
  `npm run build` green; push the branch; no PR, no deploy.
- Lead: review, merge both into one staging build, browser walkthrough, owner
  review on staging, then production.
