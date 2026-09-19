import type { Category, CategoryId } from '@/types'
import { products } from './products'

const inCat = (id: CategoryId) => products.filter((p) => p.category === id)
const stockIn = (id: CategoryId) =>
  inCat(id).reduce((total, p) => total + p.stockCount, 0)
const cheapest = (id: CategoryId) =>
  Math.min(...inCat(id).map((p) => p.price))

export const categories: Category[] = [
  {
    id: 'phones',
    label: 'Phones',
    blurb: 'Flagship handsets from Apple, Samsung, Google, OnePlus and Xiaomi.',
    unitsInStock: stockIn('phones'),
    fromPrice: cheapest('phones'),
    image: '/media/categories/phones.webp',
    span: 'large',
  },
  {
    id: 'audio',
    label: 'Audio & headphones',
    blurb: 'Headphones, earbuds, speakers and studio instruments.',
    unitsInStock: stockIn('audio'),
    fromPrice: cheapest('audio'),
    image: '/media/categories/audio.webp',
    span: 'large',
  },
  {
    id: 'peripherals',
    label: 'Keyboards & mice',
    blurb: 'Mechanical keyboards, precision mice and monitors.',
    unitsInStock: stockIn('peripherals'),
    fromPrice: cheapest('peripherals'),
    image: '/media/categories/peripherals.webp',
    span: 'square',
  },
  {
    id: 'imaging',
    label: 'Cameras & drones',
    blurb: 'Mirrorless bodies, drones, gimbals and webcams.',
    unitsInStock: stockIn('imaging'),
    fromPrice: cheapest('imaging'),
    image: '/media/categories/imaging.webp',
    span: 'square',
  },
  {
    id: 'computing',
    label: 'Laptops & wearables',
    blurb: 'Laptops, phones, smartwatches and charging.',
    unitsInStock: stockIn('computing'),
    fromPrice: cheapest('computing'),
    image: '/media/categories/computing.webp',
    span: 'wide',
  },
]
