import type { Brand } from '@/types'
import { products } from './products'

const countFor = (id: string) => products.filter((p) => p.brand === id).length

/**
 * Accents are brand-adjacent but deliberately desaturated — they tint a preview
 * panel, they are not the brand's own logo colour and should not shout.
 */
export const brands: Brand[] = [
  {
    id: 'APPLE',
    name: 'Apple',
    tagline: 'Silicon, displays and personal audio',
    productCount: countFor('APPLE'),
    previewImage: '/media/brands/apple.webp',
    accent: '#A1A1A6',
  },
  {
    id: 'SAMSUNG',
    name: 'Samsung',
    tagline: 'Mobile, displays and memory',
    productCount: countFor('SAMSUNG'),
    previewImage: '/media/brands/samsung.webp',
    accent: '#5B7CE8',
  },
  {
    id: 'SONY',
    name: 'Sony',
    tagline: 'Imaging sensors and reference audio',
    productCount: countFor('SONY'),
    previewImage: '/media/brands/sony.webp',
    accent: '#C9CDD4',
  },
  {
    id: 'BOSE',
    name: 'Bose',
    tagline: 'Noise cancellation and portable sound',
    productCount: countFor('BOSE'),
    previewImage: '/media/brands/bose.webp',
    accent: '#D6DAE0',
  },
  {
    id: 'SENNHEISER',
    name: 'Sennheiser',
    tagline: 'Studio monitoring and open-back reference',
    productCount: countFor('SENNHEISER'),
    previewImage: '/media/brands/sennheiser.webp',
    accent: '#5E8BD9',
  },
  {
    id: 'DJI',
    name: 'DJI',
    tagline: 'Aerial imaging and stabilisation',
    productCount: countFor('DJI'),
    previewImage: '/media/brands/dji.webp',
    accent: '#5FB7E8',
  },
  {
    id: 'LOGITECH',
    name: 'Logitech',
    tagline: 'Input devices and conferencing',
    productCount: countFor('LOGITECH'),
    previewImage: '/media/brands/logitech.webp',
    accent: '#63B8DC',
  },
  {
    id: 'RAZER',
    name: 'Razer',
    tagline: 'Gaming peripherals and laptops',
    productCount: countFor('RAZER'),
    previewImage: '/media/brands/razer.webp',
    accent: '#6FBF5C',
  },
  {
    id: 'ANKER',
    name: 'Anker',
    tagline: 'Power delivery and everyday audio',
    productCount: countFor('ANKER'),
    previewImage: '/media/brands/anker.webp',
    accent: '#4FA8CC',
  },
  {
    id: 'NOTHING',
    name: 'Nothing',
    tagline: 'Transparent consumer hardware',
    productCount: countFor('NOTHING'),
    previewImage: '/media/brands/nothing.webp',
    accent: '#E3E3E6',
  },
  {
    id: 'GOOGLE',
    name: 'Google',
    tagline: 'Tensor silicon and computational photography',
    productCount: countFor('GOOGLE'),
    previewImage: '/media/brands/google.webp',
    accent: '#4C8DF6',
  },
  {
    id: 'ONEPLUS',
    name: 'OnePlus',
    tagline: 'Fast charging and high-refresh displays',
    productCount: countFor('ONEPLUS'),
    previewImage: '/media/brands/oneplus.webp',
    accent: '#C8453C',
  },
  {
    id: 'XIAOMI',
    name: 'Xiaomi',
    tagline: 'Flagship hardware at aggressive pricing',
    productCount: countFor('XIAOMI'),
    previewImage: '/media/brands/xiaomi.webp',
    accent: '#E8770F',
  },
  {
    id: 'KEYCHRON',
    name: 'Keychron',
    tagline: 'Custom mechanical keyboards',
    productCount: countFor('KEYCHRON'),
    previewImage: '/media/brands/keychron.webp',
    accent: '#D9A05B',
  },
  {
    id: 'TEENAGE_ENGINEERING',
    name: 'Teenage Engineering',
    tagline: 'Portable instruments and studio gear',
    productCount: countFor('TEENAGE_ENGINEERING'),
    previewImage: '/media/brands/teenage-engineering.webp',
    accent: '#D98A4F',
  },
]

/** Display name for a brand id, for product pills and cart lines. */
export const brandName = (id: string) =>
  brands.find((b) => b.id === id)?.name ?? id.replace(/_/g, ' ')
