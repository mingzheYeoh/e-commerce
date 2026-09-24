import { describe, it, expect } from 'vitest'
import { redirectFor } from './router'
import type { StaffMe } from './api'

// The guard's routing table for each `me` shape. The worker's own tests
// carry the security; this only checks the SPA sends each shape where the
// plan says it should.

describe('redirectFor', () => {
  it('sends a stranger to /signin, except /apply and /signin themselves', () => {
    const session: StaffMe = { kind: null }
    expect(redirectFor(session, '/signin')).toBeNull()
    expect(redirectFor(session, '/apply')).toBeNull()
    expect(redirectFor(session, '/enrol')).toBe('/signin')
    expect(redirectFor(session, '/products')).toBe('/signin')
    expect(redirectFor(session, '/applications')).toBe('/signin')
  })

  it('keeps an enrolling session on /enrol or /verify only', () => {
    const session: StaffMe = { kind: 'enrolling' }
    expect(redirectFor(session, '/enrol')).toBeNull()
    expect(redirectFor(session, '/verify')).toBeNull()
    expect(redirectFor(session, '/signin')).toBe('/enrol')
    expect(redirectFor(session, '/apply')).toBe('/enrol')
    expect(redirectFor(session, '/products')).toBe('/enrol')
  })

  it('sends an active merchant to /overview, and lets it reach products and orders', () => {
    const session: StaffMe = {
      kind: 'active',
      scope: 'merchant',
      merchant: { name: 'Acme', slug: 'acme', status: 'active' },
    }
    for (const allowed of ['/overview', '/products', '/products/new', '/products/abc123', '/orders', '/orders/NX-4K2P9']) {
      expect(redirectFor(session, allowed), allowed).toBeNull()
    }
    for (const elsewhere of ['/', '/applications', '/platform', '/platform/merchants', '/signin', '/enrol', '/productsx', '/ordersheet']) {
      expect(redirectFor(session, elsewhere), elsewhere).toBe('/overview')
    }
  })

  it('sends an active platform admin to /platform, and lets it reach everything beneath', () => {
    const session: StaffMe = { kind: 'active', scope: 'platform' }
    for (const allowed of ['/platform', '/platform/merchants', '/platform/applications', '/platform/audit']) {
      expect(redirectFor(session, allowed), allowed).toBeNull()
    }
    for (const elsewhere of ['/', '/applications', '/overview', '/products', '/orders/x', '/verify', '/platformx']) {
      expect(redirectFor(session, elsewhere), elsewhere).toBe('/platform')
    }
  })
})
