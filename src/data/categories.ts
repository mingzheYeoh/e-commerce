import type { Category, CategoryId } from '@/types'
import { catalogue } from '@/stores/catalog'

// Getters over the live catalogue, like brands.ts, so the figures follow it.
const inCat = (id: CategoryId) => catalogue.value.filter((p) => p.category === id)
const stockIn = (id: CategoryId) =>
  inCat(id).reduce((total, p) => total + p.stockCount, 0)
// fromPrice is dollars (it feeds formatPrice), so the catalogue's minor units
// are converted back here, once, rather than at every category card.
// An emptied category (every product in it unpublished) reads 0, not Infinity.
const cheapest = (id: CategoryId) => {
  const prices = inCat(id).map((p) => p.priceMinor)
  return prices.length ? Math.min(...prices) / 100 : 0
}

export const categories: Category[] = [
  {
    id: 'phones',
    label: 'Phones',
    blurb: 'Flagship handsets from Apple, Samsung, Google, OnePlus and Xiaomi.',
    get unitsInStock() { return stockIn('phones') },
    get fromPrice() { return cheapest('phones') },
    image: '/media/categories/phones.webp',
    span: 'large',
  },
  {
    id: 'audio',
    label: 'Audio & headphones',
    blurb: 'Headphones, earbuds, speakers and studio instruments.',
    get unitsInStock() { return stockIn('audio') },
    get fromPrice() { return cheapest('audio') },
    image: '/media/categories/audio.webp',
    span: 'large',
  },
  {
    id: 'peripherals',
    label: 'Keyboards & mice',
    blurb: 'Mechanical keyboards, precision mice and monitors.',
    get unitsInStock() { return stockIn('peripherals') },
    get fromPrice() { return cheapest('peripherals') },
    image: '/media/categories/peripherals.webp',
    span: 'square',
  },
  {
    id: 'imaging',
    label: 'Cameras & drones',
    blurb: 'Mirrorless bodies, drones, gimbals and webcams.',
    get unitsInStock() { return stockIn('imaging') },
    get fromPrice() { return cheapest('imaging') },
    image: '/media/categories/imaging.webp',
    span: 'square',
  },
  {
    id: 'computing',
    label: 'Laptops & wearables',
    blurb: 'Laptops, smartwatches, tablets and charging.',
    get unitsInStock() { return stockIn('computing') },
    get fromPrice() { return cheapest('computing') },
    image: '/media/categories/computing.webp',
    span: 'wide',
  },
]
