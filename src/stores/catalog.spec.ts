import { setActivePinia, createPinia } from 'pinia'
import { beforeEach, describe, it, expect } from 'vitest'
import { useCatalogStore } from './catalog'
import { products } from '@/data/products'

describe('the catalogue store', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('renders the baked snapshot, in the order the file carries', () => {
    // The storefront is a static site that must paint without the API, and the
    // shop page renders `visible` as-is, so the file's order is behaviour.
    const store = useCatalogStore()
    expect(store.items).toHaveLength(products.length)
    expect(store.visible.map((p) => p.id)).toEqual(products.map((p) => p.id))
  })
})
