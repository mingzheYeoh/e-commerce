# NEXUS Catalog Expansion — Design

**Date:** 2026-09-20
**Status:** Approved by delegation ("全部你来决定")

## Goal

Grow the catalogue from 12 brands / 35 products to **24 brands / ~90 products**,
covering phones, laptops and the wider consumer-electronics field, with lineups
that match what each manufacturer actually sells as of September 2026, and with
product photography sourced from the manufacturers where it can be obtained.

## What the research established

Probed before writing this spec. These are measured results, not assumptions.

**Product data:** `WebSearch` returns accurate current information (iPhone 18 Pro
pre-orders opened 2026-09-12; Galaxy S26 Ultra shipped 2026-03-11 at $1,299.99).
The May 2026 knowledge cutoff makes search mandatory, not optional.

**Manufacturer imagery is partly reachable:**

| Source | Result |
|---|---|
| `store.storeimages.cdn-apple.com` | 200, real product JPEG |
| apple.com `og:image` | 200, genuine iPhone 18 Pro render, 1200×630 |
| `i.dell.com` `og:image` | 200, genuine Dell laptop render, 1200×630 |
| `images.samsung.com` | 200, real product JPEG |
| sony.com, lg.com, gopro.com, lenovo.com | bot wall — 300–4,200 byte stub pages |

**Two findings that constrain the design:**

1. **Resolution is capped at what the vendor publishes.** Dell's Scene7 endpoint
   is preset-locked: the published parameter set returns 200, while `wid=2400`
   and `wid=3600` both return 503. There is no arbitrary upscaling.
2. **`og:image` is correct only about half the time.** Apple and Dell return real
   product renders; Nintendo returns a generic `social-share.jpg` banner and
   Samsung returns `logo-square-letter.png`. All four are HTTP 200, valid PNG, of
   plausible dimensions. **HTTP 200 proves nothing about subject.**

## Image sourcing: a three-tier ladder

Per-brand scrapers are rejected: 24 bespoke DOM extractors, several of which
cannot run at all behind bot walls, is a maintenance liability. Instead every
product walks one ladder and stops at the first tier that yields a
subject-verified image.

```
Tier 1  Manufacturer CDN (og:image, then page HTML)   real official render
Tier 2  Wikimedia Commons                             CC-licensed, real hardware
Tier 3  Unsplash                                      category-accurate
```

Tiers 2 and 3 are the pipeline already running in `scripts/fetch-assets.mjs`.
Bot-walled brands fall through to tier 2, which for Sony and LG already produces
photographs of the actual hardware. Nothing new has to be built for the fallback.

**Licensing.** Tier 2 is CC BY-SA/CC0 and tier 3 is the Unsplash licence; both
are cleared for reuse and already carry per-image attribution. Tier 1 images are
the manufacturers' copyrighted product renders, used here for a non-commercial
portfolio demonstration. Every tier-1 image records its source URL and fetch date
in `credits.json` so any image can be traced and replaced individually.

## Subject verification is mandatory

The pipeline's existing guards (`must` keyword filter, `BRAND_WORDS` foreign-brand
rejection, content-hash de-duplication) apply to tier 1 as well, plus one new
rejection rule aimed at the failure measured above:

```
reject when the URL basename matches:
  social-share | og-default | logo | placeholder | share-image | default-meta
```

That rule alone would have caught both Nintendo and Samsung.

Automated guards are necessary but not sufficient — this project has twice shipped
wrong images that passed every script check (SONY MDR-7506 on a Sennheiser listing,
a building with a Samsung billboard). **Every image in the expansion gets an eye
check via ffmpeg contact sheet before the batch is accepted.**

## Schema changes

```ts
// src/types/index.ts
export type CategoryId = 'audio' | 'peripherals' | 'imaging' | 'computing' | 'phones'
```

`phones` is the only new category. `computing` is already labelled "Laptops &
wearables", so watches need no separate home.

`BrandId` gains twelve members:

| Category focus | New brands |
|---|---|
| Phones | `GOOGLE`, `XIAOMI`, `ONEPLUS` |
| Laptops & computing | `DELL`, `LENOVO`, `ASUS`, `MICROSOFT` |
| Audio & displays | `LG`, `JBL` |
| Imaging | `CANON`, `GOPRO` |
| Gaming | `NINTENDO` |

Total 24 brands. `MegaMenu.vue` renders brands in two columns and will need a
third, and `categories.ts` counts are derived, so both follow automatically.

## Delivery: vertical slice first

The catalogue is not built brand-by-brand across all 24 at once. A slice proves
the pipeline end to end, then the rest is repetition.

**Slice:** the `phones` category — Apple, Samsung, Google, Xiaomi, OnePlus.
Roughly 12 products. It is the right slice because the category does not exist
yet, so it exercises every layer: type union, category registry, routing, filter
chips, mega menu, product page, and all three image tiers.

Acceptance for the slice:
- 12 products with researched prices and 8 real spec rows each
- every product resolves 4 gallery images with zero duplicates
- every image eye-checked against the model it claims to be
- `/shop?category=phones` filters correctly and the mega menu shows the count
- typecheck, tests and build all clean

Scale-out to the remaining brands only after the slice is accepted.

## Per-product data requirements

Each product carries what a real retailer shows, researched rather than invented:

- current retail price and the storage/trim it refers to
- 8 `specs` rows of genuine manufacturer figures
- `specsSummary` for the card
- real colourways with correct hex values
- `sku` matching the manufacturer's model number where one is public

A product whose figures cannot be verified by search is dropped rather than
guessed. An invented spec row is worse than a shorter catalogue.

## Testing

| File | Covers |
|---|---|
| `src/data/products.spec.ts` | every product has 4 gallery paths, 8+ spec rows, a non-empty sku, a price > 0, and a `brand` that exists in `brands.ts` |
| existing `recommend.spec.ts` | extended so the intent engine resolves "phone" and "smartphone" to the new category |

The first is a data-integrity test — with ~90 hand-assembled records, a
structural check catches the typo that a reviewer's eye slides over.
