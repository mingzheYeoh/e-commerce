# Product comparison — design

**Date:** 2026-09-20
**Status:** approved, ready to implement

## What this is

A side-by-side comparison of up to four products, restricted to one category at
a time. Shoppers tick products from a card or a product page, a tray collects
them, and `/compare?ids=…` renders the table.

The restriction is the feature, not a limitation of it. A table whose columns
are a phone and a mouse has no rows that mean anything in both columns.

## The rule that matters

**The first product added locks the category.** Anything from another category
is refused.

This is enforced in two places and only one of them counts:

| Layer | What it does |
|---|---|
| `ProductCard` | Disables the checkbox and explains why |
| `compare.add()` | Returns `false` and changes nothing |

The store is the rule; the disabled checkbox is a courtesy so the shopper sees
it coming. Same shape as `cart.add()` refusing an out-of-stock product. The
store rule gets its own test, because a UI-only guard is bypassed by a URL.

## Files

| File | Responsibility |
|---|---|
| `src/stores/compare.ts` | ids, derived category lock, `canAdd`, cap of 4, `validIds()` |
| `src/lib/compare-rows.ts` | which rows a category shows, how to read each value, which direction is better |
| `src/components/commerce/CompareTray.vue` | sticky tray: thumbnails, count, Clear, Compare |
| `src/pages/ComparePage.vue` | the table |
| `src/components/commerce/ProductCard.vue` | the checkbox |
| `src/pages/ProductPage.vue` | a Compare button |
| `src/App.vue` | mounts the tray |
| `src/router/index.ts` | `/compare` |

The category is **derived** from the first id rather than stored beside it.
Two fields that must agree are two fields that can disagree.

`ProductCard`'s root element is a `RouterLink`, so the checkbox needs
`@click.stop.prevent` — without it, ticking a box navigates to the product.

## What the table shows

Universal rows: price, brand, rating. Then rows chosen per category:

| Category | Rows |
|---|---|
| phones | screen, refresh, main camera, battery, charging, storage |
| computing | memory, storage, screen, refresh, battery, charging |
| audio | battery, ports, features |
| imaging | main camera, battery, ports |
| peripherals | battery, ports, features |

Typed as `Record<CategoryId, Row[]>` so adding a category without giving it rows
is a compile error, the way `CATEGORY_WORDS` already is.

**Then every specification line any of the products publishes, verbatim,** under
an "All published specifications" heading. Curated rows alone were the first
design; it was changed on request to show everything.

The two groups are kept apart because they answer different questions and a
label can honestly appear in both. "Battery life" above is normalised to
`1680h / 360h / 100h` and ranks; "Battery" below reads "70 days, 1 min charge =
3 hours" against "15 days lit, 10 months unlit" and cannot. Merged into one
list, the table would look like it was contradicting itself.

Labels are matched case-insensitively and trimmed, so `Battery` and ` battery `
are one row. They are not otherwise normalised: mapping "Chip" onto "Processor"
is a guess about whether two manufacturers mean the same part, and a wrong merge
silently compares two different figures.

The union is wide and thin — four peripherals produce 27 labels and **none** is
answered by all four — which drives two decisions:

- Union rows are ordered by how many products answer them, so the rows everyone
  fills come first and single-product rows sink to the bottom as the footnotes
  they are.
- "Differences only" hides rows where every column agrees **and** rows only one
  product answers. One value against three blanks reads as a difference but is
  an absence. On the three-peripheral comparison this folds 15 of 23 rows.

### Three rules for the cells

**1. A missing figure renders `—`, never `0`.**
An omitted field read as zero is a defect this project has already shipped once:
the assistant claimed the XPS 16 "has a smaller battery" when Dell publishes no
figure at all. Absent and zero are different claims.

**2. Highlight a winner only where one exists.**
Price (lower), battery, watts, refresh, storage, memory, megapixels and rating
(higher) have a direction. **Screen size does not.** 6.9in is not better than
6.3in; it is a preference. Putting a green tick on the larger number invents a
conclusion the catalogue does not support. Rows with no direction are rendered
plainly, and a row where every value is equal has no winner either — marking all
four best is noise.

**3. Identical and unanswerable rows can be folded away.**
A "Differences only" toggle hides rows where every column agrees, and rows only
one product answers, because the differences are what the shopper opened the
page for. Published rows never carry a verdict at all — free text has no
direction, and "Snapdragon 8 Elite Gen 5" does not beat "A20 Pro".

## URL and persistence

`/compare?ids=iphone-18-pro,galaxy-s26-ultra` — shareable and reloadable,
matching the site's existing rule that filter state lives in the URL.

Ids arriving from the URL are **validated, not trusted**: unknown ids dropped,
ids from a second category dropped, the list capped at four. A hand-edited URL
produces a smaller comparison, never a broken page.

Tray state persists to `nexus:compare` through the Pinia `$subscribe` plugin
already registered for the cart, so no action can forget to save.

## States

| Condition | What renders |
|---|---|
| 0 selected | No tray |
| 1 selected | Tray with Compare disabled — one column is not a comparison |
| 2–4 selected | Tray active, table renders |
| `/compare` with <2 valid ids | Prompt to pick products, with a link to the shop |

The tray hides itself on `/compare`, where it would duplicate the page.

## Tests

1. The first product sets the category; a product from another is refused.
2. Removing the last product releases the lock.
3. The fourth product is accepted, the fifth is refused.
4. Adding a product already present is a no-op, not a duplicate column.
5. `validIds` drops unknown ids, cross-category ids and anything past four.
6. A product with no published battery figure renders `—`, not `0`.
7. The price row picks the lowest as winner; the rating row picks the highest.
8. The screen-size row has no winner at all.
9. A row whose values are all equal has no winner.

## Deliberately not included

- Normalising synonymous spec labels across manufacturers.
- Comparing across categories, including a "generic rows only" fallback.
- Persisting comparisons server-side. The URL already makes one shareable.
- Pulling comparison candidates from the graph's `COMPETES_WITH` edges. The
  shopper chooses; the graph is what `/api/chat` uses to answer in prose.
