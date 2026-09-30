import type { Flagship } from '@/types'

/**
 * Module 4's pinned showcase. `offset` is where each part travels to at full
 * explode, expressed in % of the stage so the layout scales with the viewport.
 */
export const flagship: Flagship = {
  sku: 'SEN-HD800S-113',
  brand: 'SENNHEISER',
  title: 'HD 800 S',
  price: 1999.95,
  image: 'https://media.nexusohm.com/flagship/flagship.webp',
  parts: [
    {
      id: 'core',
      label: 'Driver',
      spec: '56mm ring radiator dynamic transducer',
      offset: { x: -34, y: -26 },
      revealAt: 0.45,
    },
    {
      id: 'chassis',
      label: 'Design',
      spec: 'Open-back, circumaural',
      offset: { x: 36, y: -14 },
      revealAt: 0.52,
    },
    {
      id: 'acoustics',
      label: 'Acoustics',
      spec: '4Hz – 51kHz, under 0.02% THD',
      offset: { x: -30, y: 28 },
      revealAt: 0.6,
    },
    {
      id: 'cell',
      label: 'Cable',
      spec: '3m cables, 6.35mm and 4.4mm balanced',
      offset: { x: 32, y: 26 },
      revealAt: 0.68,
    },
  ],
  variants: [
    { name: 'Midnight', hex: '#1C1C1F' },
    { name: 'Titanium', hex: '#9A9AA0' },
    { name: 'Copper', hex: '#B87333' },
  ],
}
