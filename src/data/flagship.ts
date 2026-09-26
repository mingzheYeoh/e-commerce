import type { Flagship } from '@/types'

/**
 * Module 4's pinned showcase. `offset` is where each part travels to at full
 * explode, expressed in % of the stage so the layout scales with the viewport.
 */
export const flagship: Flagship = {
  sku: 'SEN-HD900-113',
  brand: 'SENNHEISER',
  title: 'HD 900 S Reference',
  price: 649,
  image: 'https://media.nexusohm.com/flagship/flagship.webp',
  parts: [
    {
      id: 'core',
      label: 'Driver',
      spec: '38mm open-back dynamic transducer',
      offset: { x: -34, y: -26 },
      revealAt: 0.45,
    },
    {
      id: 'chassis',
      label: 'Chassis',
      spec: 'Machined aluminium yoke and headband',
      offset: { x: 36, y: -14 },
      revealAt: 0.52,
    },
    {
      id: 'acoustics',
      label: 'Acoustics',
      spec: 'Sub-0.05% THD across 4Hz – 51kHz',
      offset: { x: -30, y: 28 },
      revealAt: 0.6,
    },
    {
      id: 'cell',
      label: 'Cable',
      spec: 'Detachable OFC cable, 3m balanced',
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
