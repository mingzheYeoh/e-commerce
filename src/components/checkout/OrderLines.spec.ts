import { beforeEach, describe, it, expect } from 'vitest'
import { mount, RouterLinkStub } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import OrderLines from './OrderLines.vue'
import { products } from '@/data/products'
import type { OrderLine } from '@/stores/checkout'

const live = products[0]

const line = (over: Partial<OrderLine> = {}): OrderLine => ({
  productId: live.id,
  sku: live.sku,
  title: live.title,
  brand: live.brand,
  thumb: live.media.thumb,
  unitPriceCents: 2500,
  qty: 2,
  stockCount: 1,
  ...over,
})

const render = (lines: OrderLine[]) =>
  mount(OrderLines, { props: { lines }, global: { stubs: { RouterLink: RouterLinkStub } } })

describe('the order lines', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('links a product still in the catalogue, with every detail of the line', () => {
    const w = render([line({ finish: 'Carbon', seller: 'Acme Audio', status: 'shipped' })])
    const link = w.findComponent(RouterLinkStub)
    expect(link.props('to')).toBe(`/product/${live.id}`)
    expect(link.text()).toBe(live.title)
    const text = w.text()
    expect(text).toContain('Carbon')
    expect(text).toContain(live.sku)
    expect(text).toContain('$25.00 × 2')
    expect(text).toContain('$50.00')
    expect(text).toContain('Acme Audio')
    expect(text).toContain('Shipped')
    expect(w.find('img').attributes('src')).toBe(live.media.thumb)
  })

  it('names a product no longer sold in plain text, and says so', () => {
    const w = render([line({ productId: 'prd_gone', title: 'Discontinued Thing', thumb: '' })])
    expect(w.findComponent(RouterLinkStub).exists()).toBe(false)
    expect(w.text()).toContain('Discontinued Thing')
    expect(w.text()).toContain('no longer available')
  })

  it('shows no status where the server gave none, as it does for anyone but the buyer', () => {
    const w = render([line({ seller: 'Acme Audio', status: null })])
    expect(w.text()).toContain('Acme Audio')
    expect(w.text()).not.toMatch(/Being prepared|Shipped|Delivered|Cancelled/)
  })
})
