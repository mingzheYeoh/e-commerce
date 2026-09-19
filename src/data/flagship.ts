import type { Flagship } from '@/types'

/**
 * Module 4's pinned showcase. `offset` is where each part travels to at full
 * explode, expressed in % of the stage so the layout scales with the viewport.
 */
export const flagship: Flagship = {
  sku: 'KIN-SPEC01-000',
  brand: 'KINETIC',
  title: 'SPEC_01 Planar Reference',
  price: 649,
  image: '/media/flagship/flagship.webp',
  parts: [
    {
      id: 'core',
      label: 'CORE',
      spec: 'Dual H1 Neural Processor',
      offset: { x: -34, y: -26 },
      revealAt: 0.45,
    },
    {
      id: 'chassis',
      label: 'CHASSIS',
      spec: 'CNC 6061 Aerospace Billet Aluminium',
      offset: { x: 36, y: -14 },
      revealAt: 0.52,
    },
    {
      id: 'acoustics',
      label: 'ACOUSTICS',
      spec: '40mm Custom Planar Drivers (<0.05% THD)',
      offset: { x: -30, y: 28 },
      revealAt: 0.6,
    },
    {
      id: 'cell',
      label: 'CELL',
      spec: 'Lithium-Polymer 1200mAh // 80H',
      offset: { x: 32, y: 26 },
      revealAt: 0.68,
    },
  ],
  variants: [
    { name: 'Matte Obsidian', hex: '#0D0D0E' },
    { name: 'Ghost Transparent', hex: '#8E96A0' },
    { name: 'Raw Titanium', hex: '#B6B6BA' },
  ],
}
