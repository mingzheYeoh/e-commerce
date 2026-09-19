# Multi-Page Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the single 10-screen homepage into three real pages — home, shop listing, product detail — so each page does one job and filter state lives in the URL.

**Architecture:** vue-router in history mode. The **route is the single source of truth for filters**: the shop page pushes query params on user action and mirrors `route.query` into the catalog store on navigation, one direction only, so there is no update loop and every filtered view is a shareable URL. The teardown showcase moves to the product page and renders only for products that have teardown data.

**Tech Stack:** Existing (Vue 3, TS, Tailwind, Pinia, GSAP, Lenis) plus `vue-router@4`.

## Global Constraints

- Filter state lives in `route.query`, never only in the store. `/shop?category=audio&sort=price-desc` must reproduce the exact view.
- Home page holds no filter controls and no full catalog. Its job is to send people elsewhere.
- The homepage after this work is ~4 screens, down from ~10.
- Every `ProductCard` links to `/product/:id`; adding to cart from a card must **not** navigate.
- The GSAP pin is created only on the product page, and only for a product with teardown data. Reduced motion still renders the exploded state statically.
- Existing 9 cart tests stay green.

---

### Task 1: Router and page shells

**Files:**
- Create: `src/router/index.ts`, `src/pages/HomePage.vue`, `src/pages/ShopPage.vue`, `src/pages/ProductPage.vue`, `src/pages/NotFoundPage.vue`
- Modify: `src/main.ts`, `src/App.vue`, `package.json`

**Interfaces:**
- Produces: named routes `home` (`/`), `shop` (`/shop`), `product` (`/product/:id`), `not-found`.
- Produces: `App.vue` renders `NavBar`, `SearchPalette`, `CartDrawer`, `<RouterView>`, `SiteFooter`. Sections move out of `App.vue` entirely.

- [ ] **Step 1: Install**

```bash
npm install vue-router@4
```

- [ ] **Step 2: `src/router/index.ts`**

```ts
import { createRouter, createWebHistory } from 'vue-router'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: () => import('@/pages/HomePage.vue') },
    { path: '/shop', name: 'shop', component: () => import('@/pages/ShopPage.vue') },
    { path: '/product/:id', name: 'product', component: () => import('@/pages/ProductPage.vue'), props: true },
    { path: '/:pathMatch(.*)*', name: 'not-found', component: () => import('@/pages/NotFoundPage.vue') },
  ],
  // Land at the top on a new page, but restore position on back/forward.
  scrollBehavior: (_to, _from, saved) => saved ?? { top: 0 },
})
```

- [ ] **Step 3: Wire into `main.ts`** — `createApp(App).use(createPinia()).use(router).mount('#app')`.

- [ ] **Step 4: Verify each route renders a placeholder**

Run: `npm run dev`, visit `/`, `/shop`, `/product/wh1000xm6`, `/nonsense`
Expected: four different pages, no console errors.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add router and page shells"
```

---

### Task 2: Shop page with URL-driven filters

**Files:**
- Modify: `src/pages/ShopPage.vue`, `src/stores/catalog.ts`, `src/components/sections/ProductDropGrid.vue` (becomes `src/components/commerce/ProductGrid.vue`)

**Interfaces:**
- `useCatalogStore()` gains `activeBrand: string | null`; `visible` filters by category, in-stock, **and** brand.
- Query contract: `?category=audio|peripherals|imaging|computing`, `?stock=in`, `?brand=SONY`, `?sort=price-desc`. Absent means unset.

- [ ] **Step 1: Add brand filtering to the catalog store**

```ts
visible: (state) => {
  const filtered = products.filter((p) => {
    if (state.activeBrand && p.brand !== state.activeBrand) return false
    if (state.activeFilter === 'inStock') return p.inStock
    if (state.activeFilter !== 'all') return p.category === state.activeFilter
    return true
  })
  return state.sort === 'priceDesc' ? [...filtered].sort((a, b) => b.price - a.price) : filtered
}
```

- [ ] **Step 2: Mirror the URL into the store, one direction only**

```ts
watch(
  () => route.query,
  (q) => {
    catalog.activeFilter = (q.stock === 'in' ? 'inStock' : (q.category as Filter)) ?? 'all'
    catalog.activeBrand = (q.brand as string) ?? null
    catalog.sort = q.sort === 'price-desc' ? 'priceDesc' : 'default'
  },
  { immediate: true },
)
```

User actions call `router.push({ query })`. Nothing writes to the store directly — that is what keeps this from looping.

- [ ] **Step 3: Page header shows the active filter in words** — e.g. "Audio · 15 products" or "Sony · 3 products", plus a "Clear filters" link when any are set.

- [ ] **Step 4: Verify**

Visit `/shop?category=audio&sort=price-desc`, reload the page.
Expected: chips come back active, products filtered and sorted, count correct. Changing a chip updates the address bar.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: shop page with shareable filter URLs"
```

---

### Task 3: Product detail page

**Files:**
- Create: `src/components/commerce/ProductGallery.vue`, `src/components/commerce/BuyBox.vue`
- Modify: `src/pages/ProductPage.vue`, `src/components/sections/DeconstructedFlagship.vue`

**Interfaces:**
- `ProductPage` resolves `products.find(p => p.id === route.params.id)`; an unknown id renders the not-found content rather than throwing.
- `BuyBox` props: `product: Product`. Owns colorway selection and the add-to-cart button.
- `DeconstructedFlagship` renders only when `flagship.sku === product.sku`.

- [ ] **Step 1: Layout** — two columns at `lg`: gallery left, buy box right; stacked below. Breadcrumb `Home / Audio / WH-1000XM6`.

- [ ] **Step 2: Gallery** — hero image with the alt image as a second thumbnail; clicking a thumbnail swaps the main image.

- [ ] **Step 3: Buy box** — brand, title, rating, price, stock line, colorway swatches, quantity, add to cart, delivery/returns/warranty notes.

- [ ] **Step 4: Specs** — `specsSummary` as a definition list, plus the SKU.

- [ ] **Step 5: Teardown** — render `DeconstructedFlagship` below the fold for the flagship product only.

- [ ] **Step 6: Related products** — four more from the same category, excluding the current one.

- [ ] **Step 7: Verify**

Visit `/product/wh1000xm6` and `/product/hd900s` and `/product/nope`.
Expected: both real products render; only `hd900s` pins and explodes; `nope` shows the not-found page. Adding to cart works from the buy box.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: product detail page with gallery and buy box"
```

---

### Task 4: Trim the homepage

**Files:**
- Modify: `src/pages/HomePage.vue`, `src/components/sections/HeroViewport.vue`, `src/components/sections/BrandMatrix.vue`, `src/components/sections/CategoryLaunchpad.vue`
- Create: `src/components/sections/FeaturedRail.vue`, `src/components/sections/PromoFeature.vue`

**Interfaces:**
- `FeaturedRail` — at most 8 products: everything badged `NEW_DROP` or `LIMITED_EDITION` first, then by rating, then a "View all 35 products" link to `/shop`.
- `PromoFeature` — one large image, one line of copy, and a link to the flagship's product page. Replaces the pinned teardown on the homepage.

- [ ] **Step 1: Home composition** — Hero, CategoryLaunchpad, FeaturedRail, BrandMatrix (slim), PromoFeature, and nothing else.

- [ ] **Step 2: Category cards link to `/shop?category=…`** rather than scrolling to an anchor.

- [ ] **Step 3: Brand strip slims down** — drop the large hover preview panel; each brand links to `/shop?brand=…`.

- [ ] **Step 4: Nav links become routes** — Shop, and category links to `/shop?category=…`; the logo goes to `/`.

- [ ] **Step 5: Verify the reduction**

```bash
# with the dev server running
node -e "console.log('measure homepage height in the browser')"
```

In the browser: `document.body.scrollHeight / window.innerHeight`
Expected: roughly 4, down from roughly 10.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: trim homepage to hero, categories, featured, brands, promo"
```

---

### Task 5: Cross-page wiring and final verification

**Files:**
- Modify: `src/components/commerce/ProductCard.vue`, `src/components/layout/SearchPalette.vue`, `src/components/layout/CartDrawer.vue`, `README.md`

- [ ] **Step 1: ProductCard links to its product page** — the card is a `RouterLink`, and the add-to-cart button calls `@click.stop.prevent` so it adds without navigating.

- [ ] **Step 2: Search palette navigates** — Enter opens the product page instead of adding to the cart, which is what a search result is for. A separate quick-add button on the row keeps the add path.

- [ ] **Step 3: Cart lines link to their product page.**

- [ ] **Step 4: README** — document the three routes and the query contract.

- [ ] **Step 5: Final gate**

```bash
npm run test && npx vue-tsc --noEmit && npm run build
```

Expected: 9 tests pass, no type errors, build succeeds. Then in the browser: home, shop, a filtered shop URL after reload, a product page, add to cart from card and from buy box, zero console errors.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: cross-page navigation wiring"
```
