# NEXUS

**Live: https://nexus-tech-collective.mingzhe030228.workers.dev**

A multi-brand consumer-electronics storefront built as an AI-engineering
showcase: 18 brands, 45 products across five categories, real manufacturer
photography, five currencies, and a checkout that runs from cart to
confirmation.

The retrieval, question answering and shopping assistant are the point — see
[AI engineering](#ai-engineering). No third-party model API key exists in the
project: query embeddings run on the visitor's device, and inference runs on
Cloudflare Workers AI, where the binding *is* the credential.

> Demo project. NEXUS is not a real retailer, the payment gateway is simulated
> with Stripe's published test card numbers, and nothing takes money or ships.

## Environments and branches

Production keeps its URL while anything is being looked at.

| | Branch | Site | API |
|---|---|---|---|
| **production** | `main` | [nexus-tech-collective](https://nexus-tech-collective.mingzhe030228.workers.dev) | `nexus-api` |
| **staging** | `staging` | [...-staging](https://nexus-tech-collective-staging.mingzhe030228.workers.dev) | `nexus-api-staging` |

Nothing is committed to `main` directly. Work goes
`feat/<name>` → PR → `staging` → PR → `main`.

```bash
git checkout staging && git pull
git checkout -b feat/whatever
# ... work, npm test, npm run typecheck ...
gh pr create --base staging

npm run deploy:staging     # site + build pointed at the staging API
cd worker && npx wrangler deploy --env staging

# once it looks right on the staging URL
gh pr create --base main --head staging
npm run deploy             # production
```

The two environments share Workers AI and the Vectorize index — both are
read-only from the API, and a second copy of the index would only drift.
**Orders go to separate D1 databases,** so a test checkout never lands in the
production ledger.

Wrangler does not inherit bindings into an environment, so every one is
repeated under `[env.staging]`. An omitted binding does not warn; it deploys a
worker that is missing it.

Secrets are per-environment too. Staging has none set, so its `/api/health`
reports `graph: false` with `"credentials not configured"` — the degraded mode
the code already handles. To give staging its own graph:

```bash
cd worker
npx wrangler secret put NEO4J_URI --env staging
npx wrangler secret put NEO4J_USER --env staging
npx wrangler secret put NEO4J_PASSWORD --env staging
```

## Run it

```bash
npm install
npm run dev           # http://localhost:5173
```

Media is committed, so the site runs offline straight after clone. To re-pick
the photography from scratch:

```bash
npm run assets        # ~2 min, needs network
```

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | Production build |
| `npm run test` | Vitest — cart store logic |
| `npm run typecheck` | `vue-tsc --noEmit` |
| `npm run assets` | Download and re-encode all media |
| `npm run deploy` | Build and publish the storefront |

The API is a separate deployment, so the thing serving public HTML and the thing
holding the Neo4j password are not the same script:

```bash
cd worker && npx wrangler deploy     # https://nexus-api.mingzhe030228.workers.dev
```

### Routes

| Route | Page |
|---|---|
| `/` | Home — hero, categories, eight curated products, brand strip, one feature |
| `/shop` | All products, with filters |
| `/product/:id` | Product detail; the teardown showcase renders here for the flagship |

**Filter state lives in the URL**, so any view can be shared or reloaded:

    /shop?category=audio&sort=price-desc
    /shop?brand=SONY
    /shop?stock=in

The route is the single source of truth — the shop page mirrors `route.query`
into the catalog store and never the other way round, which is what keeps it
from looping.

### Search that reads a sentence

The search box (⌘K) takes either a fragment or a sentence. A sentence goes
through `src/lib/recommend.ts`, which pulls **structured constraints** out of
free text and scores the catalogue against them:

    "headphones for a noisy flight under $500"
      -> budget: 500 (a hard ceiling — "under" means under)
      -> intent: blocking out noise
      -> category: audio

What it understood is shown above the results, so a shopper never has to guess
why a product came back — and the seam is visible when it understood nothing.

This is a local intent engine, not a language model. It runs offline in a
fraction of a millisecond and there is no key to leak, but it only knows the
intents in its table. Everything sits behind one `recommend()` call, so putting
a real model behind a serverless function later is a change to that file alone.

### Query flags

- `?motion=on` — force animation even when the OS asks for reduced motion
- `?motion=off` — force the static page
- `/__viewports.html` — dev rig that renders the site in 390px and 768px iframes side by side

## AI engineering

Three layers, each answering a question the one below it could not.

### 1. Retrieval, measured two ways

Two retrieval stacks run against the same 22-query hand-judged set
(`npm run eval:search -- --remote --ablate`):

| strategy | where | precision@3 | recall@5 | MRR |
|---|---|---|---|---|
| keyword | device, no model | 33.3% | 65.0% | 58.6% |
| semantic | device, MiniLM-L6 | 40.9% | 79.8% | 73.3% |
| hybrid (RRF) | device, both | 40.9% | 70.7% | 72.7% |
| **vector** | **Cloudflare, bge-small + Vectorize** | **45.5%** | **82.3%** | **88.4%** |
| vector + keyword | RRF of the two | 45.5% | 77.5% | 72.3% |

Two results worth more than the winning row:

**Reciprocal Rank Fusion helps a weak retriever and hurts a strong one.** Fusing
keyword into the hosted index costs **16 points of MRR** — RRF fuses positions,
so a confident correct hit at rank 1 gets dragged down by a second ranker that
disagrees. Hybrid is a fix for a retriever that misses, not an upgrade for one
that does not.

**The hosted stack changed two things at once,** the model *and* the text each
product is embedded as, so the headline gap was unattributable until both were
varied separately (`--ablate`, exact cosine, no ANN index):

| model | document text | precision@3 | recall@5 | MRR |
|---|---|---|---|---|
| MiniLM-L6 | specs only | 42.4% | 75.2% | 72.9% |
| MiniLM-L6 | prose + facts | 43.9% | 79.2% | 76.3% |
| bge-small | specs only | 47.0% | **87.3%** | 79.9% |
| bge-small | prose + facts | 45.5% | 84.5% | **88.4%** |

Both changes pay, and they compound: the richer text is worth 3.4 MRR points to
MiniLM and 8.5 to bge-small. A better model extracts more from better text than
a weaker one does, so "swap the model" and "improve the corpus" are not
independent line items. Note also that bge-small on *specs only* has the best
recall@5 of any cell — the prose passages sharpen the top of the ranking and
cost a little breadth.

That last row is the deployed configuration, and the eval reaches it twice by
different routes: once locally with an exact scan, once through the live
endpoint. They agree on precision@3 and MRR to the decimal, which is what makes
the remote number trustworthy rather than merely favourable. **Vectorize's
approximate search costs 2.3 points of recall@5 and nothing at all at the top of
the ranking.** The run fails loudly if those two ever drift apart, because the
most likely cause is a deployed index built from stale data — which is exactly
the defect this comparison found the first time it ran.

Latency is why the slower stack did not simply take over. On-device embedding
answers in **11 ms** (p50, excluding the one-off model download); the hosted
round trip is **328 ms**, of which 102 ms is the embedding and 193 ms is
Vectorize. The search box stays on-device; `/api/ask` and `/api/chat`, where a
model is about to spend a second thinking anyway, retrieve from the hosted
index.

`src/lib/retrieval.ts` is imported by both the eval script and live search, and
`src/lib/passages.ts` by both index builders and the ablation, so every number
above describes shipped code rather than a copy of it.

### 2. Grounded answers, and a knowledge graph for what embeddings cannot do

`POST /api/ask` retrieves from Cloudflare Vectorize and answers with Workers AI,
then **verifies every citation** against what was actually retrieved. A question
the catalogue does not cover is refused, and refusal is reported as an explicit
flag rather than string-matched out of the prose — an ungrounded answer and a
correct refusal look identical in the text and must not look identical on screen.

Constraint queries ("which chargers can power this laptop?") go to a Neo4j graph
instead. Embeddings rank by similarity; they cannot intersect a wattage with a
port type. Adding the graph took a 60W query from 3 products to 6.

### 3. A shopping assistant that shows its work

`POST /api/chat` is a bounded tool-calling loop — four tools, `MAX_STEPS=4`, tool
output truncated, and a final turn with the tools withheld so the loop always
terminates in prose. The response carries every call it made, and the UI renders
them: the reasoning is inspectable rather than a black box.

The lessons were all about tool contracts, not prompts. The model passes
`"MacBook Pro"`, not an id, so tools resolve names. An omitted field read as
zero once made it claim the XPS 16 "has a smaller battery" when Dell publishes
none — omitted fields now return `"not published"`.

## Architecture

```
src/
├─ pages/        HomePage · ShopPage · ProductPage · NotFoundPage
├─ router/
├─ components/
│  ├─ layout/    NavBar · CartDrawer · SearchPalette · SiteFooter
│  ├─ sections/  HeroViewport · CategoryLaunchpad · FeaturedRail · BrandMatrix
│  │             PromoFeature · DeconstructedFlagship (+ flagship/LayeredRenderer)
│  ├─ commerce/  ProductCard · BuyBox · StockBadge · PriceTag
│  └─ fx/        VideoBackdrop
├─ composables/  useLenis · useReducedMotion · useCurrency · useFocusTrap
├─ data/         products · brands · categories · flagship · credits.json
├─ stores/       cart (+ spec) · catalog · ui
└─ types/
scripts/fetch-assets.mjs
```

Three Pinia stores. `catalog` is a projection of the URL and `ui` holds display
preferences; `cart` is the only one with real business logic, and the only one
with tests:

- lines merge by SKU instead of duplicating
- quantity is clamped to `stockCount`; a sold-out product cannot be added
- **money is held as integer cents.** `899.95 × 3` in floats is
  `2699.8500000000004`; the store never does that arithmetic.

### Motion

`useReducedMotion()` is the single writer of `<html data-motion>`, and every
kill switch — CSS animations, Lenis, the GSAP pin — keys off it. With reduced
motion the flagship section renders its fully exploded state statically instead
of pinning the viewport for 300vh: the same information, no choreography.

`html` must keep `scroll-behavior: auto`. Lenis sets the scroll position every
frame, and letting the browser animate on top of that is a feedback loop that
locks the main thread.

### The scrollytelling section

`DeconstructedFlagship.vue` owns the ScrollTrigger pin, scroll progress, and the
purchase panel. It renders the visual through a child that takes exactly one
prop, `progress: 0..1`. Swapping the layered renderer for a three.js one is a
change to that child alone.

Everything inside the renderer is positioned in percentages of a **square**
stage. That matters: CSS percentage margins and translates resolve against width
(or the element's own box), so on a wide, short stage a vertical offset means
something different from the same horizontal offset, and the diagram shears.

## Asset pipeline

`scripts/fetch-assets.mjs` downloads real, licensed photography into
`public/media/` — nothing is hotlinked. Each job declares a search query, and
the script ranks candidates in three passes:

1. **Subject** — keep results whose caption actually names the object. Ranking
   by popularity alone gives an aerial landscape for "drone" and a studio mood
   shot for "synthesizer".
2. **Foreign brands** — drop candidates whose caption names a brand this product
   is not sold under, so a Sennheiser listing does not ship a photo captioned
   "sony headphones". This only reads the caption; a logo visible in the pixels
   but absent from the text still gets through, which is why the images have to
   be looked at before shipping.
3. **Uniqueness** — hash the encoded output and reject a photo already used
   elsewhere in the catalogue. Hashing the bytes rather than tracking photo ids
   is what makes this hold across incremental runs: ids otherwise have to be
   parsed back out of URLs, and an Unsplash id can itself start with a dash.
   Variants are grouped into slots so a product's thumbnail and hero are always
   the same photograph.
4. **Luma** — measure the real pixels of the top candidates and prefer dark
   frames, because a photo on a bright backdrop reads as a hole punched in a
   `#050505` page. Jobs can set `targetLuma` instead, which the flagship does:
   its image is the one a visitor has to read in detail, so neither the darkest
   (unreadable) nor the brightest (warm lifestyle shots that fight the palette).
5. **Encode** — 1600w WebP plus a 400w thumbnail via sharp.

The script is idempotent (existing files are skipped) and fail-soft (a failed
asset logs `SKIP` and the run still exits 0).

### Where the photographs come from

Two sources, in priority order:

1. **[Wikimedia Commons](https://commons.wikimedia.org)** — photographs of the
   *actual* products: a real Mavic 4 Pro, a real Apple Watch Ultra. This is the
   only way to get a product shot that matches the listing, because stock
   libraries only have lookalikes and manufacturer press images are licensed
   for editorial use, not for a storefront. Most Commons files are CC BY-SA,
   which requires the author and licence to be named wherever the image
   appears — so they are printed under the product gallery, not just in the
   footer.
2. **[Unsplash](https://unsplash.com)** — fills the gallery where Commons has
   nothing, which is most earbuds and accessories.

Hero video: [Pexels](https://pexels.com). Every credit is captured in
`src/data/credits.json` at fetch time.

Each product carries up to four angles plus a thumbnail. The product page probes
each path before rendering it, because Commons coverage is uneven and a 404 in a
gallery is worse than a shorter gallery.

## Deviations from the original brief

| Brief | Built | Why |
|---|---|---|
| Video backdrops on hero, 4 category cards, 6 brand previews and every product card | Video on the hero only; stills elsewhere, with a second-angle cross-fade on card hover | 15+ clips is 80MB+ and an unusable LCP on mobile. A second still costs ~200KB against ~6MB for the same read. |
| Three named mixkit/coverr video URLs | Pexels clip, downloaded locally | All three were dead on test: mixkit 403s hotlinks, the coverr URL 404s. |
| Module 4 as an 80–120 frame pre-rendered sequence | Layered exploded diagram driven by scroll progress | That frame sequence is a 3D render deliverable; it cannot be sourced. The renderer is isolated behind one prop so a three.js version can replace it. |
| `Product.media.hoverVideoUrl` | `media.hoverImage` | Follows from the video budget above. |
| Checkout | Cart drawer only; checkout button is visibly disabled | A homepage has no checkout entry point. Stripe test mode belongs with the PDP and checkout pages. |

## What is not here

No backend and no checkout. The catalogue is 35 typed fixtures in `src/data/`,
not an API, and the checkout button is visibly disabled rather than pretending
to work.
