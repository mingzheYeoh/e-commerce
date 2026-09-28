import { beforeEach, describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import CategoryLaunchpad from './CategoryLaunchpad.vue'
import BrandMatrix from './BrandMatrix.vue'
import ProductCard from '@/components/commerce/ProductCard.vue'
import { categories } from '@/data/categories'
import { brands } from '@/data/brands'
import { products } from '@/data/products'

async function mountWith(component: unknown, props: Record<string, unknown> = {}) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:any(.*)*', component: { template: '<div />' } }],
  })
  await router.push('/')
  await router.isReady()
  return mount(component as never, { props: props as never, global: { plugins: [router] } })
}

beforeEach(() => setActivePinia(createPinia()))

describe('CategoryLaunchpad bento', () => {
  it('keeps one link per department into the filtered shop, with its stock count', async () => {
    const w = await mountWith(CategoryLaunchpad)
    const links = w.findAll('a')
    expect(links).toHaveLength(categories.length)
    categories.forEach((c, i) => {
      expect(links[i].attributes('href')).toBe(`/shop?category=${c.id}`)
      expect(links[i].text()).toContain(`${c.unitsInStock} in stock`)
    })
  })

  it('makes the first department the one large tile', async () => {
    const w = await mountWith(CategoryLaunchpad)
    const links = w.findAll('a')
    expect(links[0].classes()).toContain('lg:row-span-2')
    for (const l of links.slice(1)) expect(l.classes()).not.toContain('lg:row-span-2')
  })
})

describe('BrandMatrix marquee', () => {
  it('exposes every brand exactly once to assistive tech and the keyboard', async () => {
    const w = await mountWith(BrandMatrix)
    const reachable = w
      .findAll('a')
      .filter((a) => a.attributes('tabindex') !== '-1' && !a.element.closest('[aria-hidden="true"]'))
    const ids = reachable
      .map((a) => new URL(a.attributes('href')!, 'http://x').searchParams.get('brand'))
      .filter((id) => id !== null) // the "View all products" link
    expect(ids.sort()).toEqual(brands.map((b) => b.id).sort())
  })

  it('hides every repeat from assistive tech and takes it out of the tab order', async () => {
    const w = await mountWith(BrandMatrix)
    const copies = w.findAll('[data-copy]')
    expect(copies.length).toBeGreaterThan(0)
    for (const c of copies) {
      expect(c.attributes('aria-hidden')).toBe('true')
      expect(c.get('a').attributes('tabindex')).toBe('-1')
    }
  })

  it('runs two rows in opposite directions', async () => {
    const w = await mountWith(BrandMatrix)
    const tracks = w.findAll('.marquee-track')
    expect(tracks).toHaveLength(2)
    expect(tracks.filter((t) => t.attributes('data-reverse') !== undefined)).toHaveLength(1)
  })
})

describe('ProductCard hover effects', () => {
  const product = products.find((p) => p.inStock)!

  it('keeps add to cart a real, labelled button in the tab order', async () => {
    // It slides in on hover, but only visually: keyboard and touch reach it
    // exactly as before.
    const w = await mountWith(ProductCard, { product })
    const button = w.get(`button[aria-label="Add ${product.title} to cart"]`)
    expect(button.classes()).toContain('card-action')
    expect(button.attributes('tabindex')).toBeUndefined()
    expect(button.attributes('aria-hidden')).toBeUndefined()
  })

  it('carries the tilt and the light as classes, not as rendered inline styles', async () => {
    const w = await mountWith(ProductCard, { product })
    const card = w.get('a')
    expect(card.classes()).toEqual(expect.arrayContaining(['tilt', 'spotlight']))
    expect(card.attributes('style')).toBeUndefined()
  })
})
