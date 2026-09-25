/** Display words for the values the worker stores. */
export const METHOD: Record<string, string> = { standard: 'Standard', express: 'Express', overnight: 'Overnight' }

/** Where your part of an order stands, and the badge it wears. */
export const FULFILMENT: Record<string, { label: string; badge: string }> = {
  pending: { label: 'To ship', badge: 'border-accent-amber/40 text-accent-amber' },
  shipped: { label: 'Shipped', badge: 'border-accent/40 text-accent' },
  delivered: { label: 'Delivered', badge: 'border-accent-green/40 text-accent-green' },
  cancelled: { label: 'Cancelled', badge: 'border-border-strong text-text-secondary' },
}

/** SQLite's UTC `YYYY-MM-DD HH:MM:SS`, as written, minus the seconds. */
export const placed = (at: string) => at.slice(0, 16)
