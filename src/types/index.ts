export type BrandId =
  | 'APPLE'
  | 'SAMSUNG'
  | 'SONY'
  | 'BOSE'
  | 'SENNHEISER'
  | 'DJI'
  | 'LOGITECH'
  | 'RAZER'
  | 'ANKER'
  | 'NOTHING'
  | 'KEYCHRON'
  | 'TEENAGE_ENGINEERING'

export type CategoryId = 'audio' | 'peripherals' | 'imaging' | 'computing'

export interface Colorway {
  name: string
  hex: string
}

export interface Product {
  id: string
  sku: string
  brand: BrandId
  title: string
  category: CategoryId
  /** Base price in USD. Converted for display only — never used for arithmetic. */
  price: number
  currency: string
  inStock: boolean
  stockCount: number
  badge?: 'NEW_DROP' | 'LIMITED_EDITION' | 'DISCOUNT'
  rating: number
  reviewCount: number
  specsSummary: string[]
  media: {
    heroImage: string
    /** Cross-faded in on card hover. The original spec called for a video here;
     *  a second still costs ~200KB instead of ~6MB for the same read. */
    hoverImage?: string
    thumb: string
  }
  colorways: Colorway[]
}

export interface Brand {
  id: string
  name: string
  tagline: string
  productCount: number
  previewImage: string
  /** Muted brand tint for the preview panel. */
  accent: string
}

export interface Category {
  id: CategoryId
  label: string
  blurb: string
  /** Total units on hand across the category, not the number of SKUs. */
  unitsInStock: number
  fromPrice: number
  image: string
  /** Bento placement. `large` anchors the grid; the rest fill around it. */
  span: 'large' | 'square' | 'wide'
}

export interface FlagshipPart {
  id: string
  label: string
  spec: string
  /** Where the part travels to at full explode, in % of the stage. */
  offset: { x: number; y: number }
  /** Scroll progress (0..1) at which this part's leader line draws in. */
  revealAt: number
}

export interface Flagship {
  sku: string
  brand: BrandId
  title: string
  price: number
  image: string
  parts: FlagshipPart[]
  variants: Colorway[]
}

export interface Credit {
  file: string
  photographer: string
  profileUrl: string
  sourceUrl: string
  source: string
}
