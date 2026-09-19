import type { Category, CategoryId } from '@/types'
import { products } from './products'

const inCat = (id: CategoryId) => products.filter((p) => p.category === id)
const stockIn = (id: CategoryId) =>
  inCat(id).reduce((total, p) => total + p.stockCount, 0)
const cheapest = (id: CategoryId) =>
  Math.min(...inCat(id).map((p) => p.price))

export const categories: Category[] = [
  {
    id: 'audio',
    label: 'ACOUSTICS & SYNTHESIS',
    blurb: 'Studio monitors, planar reference cans and modular voices.',
    unitsInStock: stockIn('audio'),
    fromPrice: cheapest('audio'),
    image: '/media/categories/audio.webp',
    span: 'large',
  },
  {
    id: 'peripherals',
    label: 'CYBERNETIC PERIPHERALS',
    blurb: 'Gasket-mount boards, switches and control surfaces.',
    unitsInStock: stockIn('peripherals'),
    fromPrice: cheapest('peripherals'),
    image: '/media/categories/peripherals.webp',
    span: 'square',
  },
  {
    id: 'imaging',
    label: 'AERIAL & SPATIAL IMAGING',
    blurb: 'Enterprise airframes, gimbals and full-frame bodies.',
    unitsInStock: stockIn('imaging'),
    fromPrice: cheapest('imaging'),
    image: '/media/categories/imaging.webp',
    span: 'square',
  },
  {
    id: 'computing',
    label: 'WEARABLE AUGMENTATION',
    blurb: 'Micro-OLED optics, biometrics and field computers.',
    unitsInStock: stockIn('computing'),
    fromPrice: cheapest('computing'),
    image: '/media/categories/computing.webp',
    span: 'wide',
  },
]
