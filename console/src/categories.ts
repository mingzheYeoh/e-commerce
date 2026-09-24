/**
 * The storefront's category ids and labels (see `src/data/categories.ts`),
 * copied rather than imported: that module pulls in the full product
 * fixture to compute stock counts and "from" prices, none of which the
 * console needs, and its `@/` alias resolves to `console/src` here, not the
 * root `src`. A category is a select, not free text — the storefront filters
 * by these exact ids, so a merchant typing "Phones" would make their product
 * vanish from the shop.
 *
 * Keep in sync with `src/data/categories.ts` if a category is ever added.
 */
export const CATEGORIES: { id: string; label: string }[] = [
  { id: 'phones', label: 'Phones' },
  { id: 'audio', label: 'Audio & headphones' },
  { id: 'peripherals', label: 'Keyboards & mice' },
  { id: 'imaging', label: 'Cameras & drones' },
  { id: 'computing', label: 'Laptops & wearables' },
]
