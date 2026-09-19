import type { Brand } from '@/types'
import { products } from './products'

const countFor = (id: string) => products.filter((p) => p.brand === id).length

export const brands: Brand[] = [
  {
    id: 'TEENAGE_ENGINEERING',
    name: 'TEENAGE ENGINEERING',
    tagline: 'Swedish modular instruments',
    productCount: countFor('TEENAGE_ENGINEERING'),
    previewImage: '/media/brands/teenage-engineering.webp',
    accent: '#FF5500',
  },
  {
    id: 'NOTHING',
    name: 'NOTHING TECH',
    tagline: 'Transparent consumer hardware',
    productCount: countFor('NOTHING'),
    previewImage: '/media/brands/nothing.webp',
    accent: '#F5F5F7',
  },
  {
    id: 'DJI',
    name: 'DJI LABS',
    tagline: 'Aerial imaging systems',
    productCount: countFor('DJI'),
    previewImage: '/media/brands/dji.webp',
    accent: '#00F0FF',
  },
  {
    id: 'SONY',
    name: 'SONY PRO',
    tagline: 'Reference optics and acoustics',
    productCount: countFor('SONY'),
    previewImage: '/media/brands/sony.webp',
    accent: '#39FF14',
  },
  {
    id: 'KEYCHRON',
    name: 'KEYCHRON',
    tagline: 'Custom mechanical interfaces',
    productCount: countFor('KEYCHRON'),
    previewImage: '/media/brands/keychron.webp',
    accent: '#FF5500',
  },
  {
    id: 'KINETIC',
    name: 'KINETIC',
    tagline: 'Boutique studio hardware',
    productCount: countFor('KINETIC'),
    previewImage: '/media/brands/kinetic.webp',
    accent: '#00F0FF',
  },
]
