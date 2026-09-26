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
    for (const allowed of [
      '/overview',
      '/products',
      '/products/new',
      '/products/abc123',
      '/orders',
      '/orders/NX-4K2P9',
      '/reports',
      '/inventory',
      '/finance',
      '/returns',
      '/returns/ret_abc',
      '/reviews',
    ]) {
      expect(redirectFor(session, allowed), allowed).toBeNull()
    }
    for (const elsewhere of [
      '/',
      '/applications',
      '/platform',
      '/platform/merchants',
      '/signin',
      '/enrol',
      '/productsx',
      '/ordersheet',
      '/reportsx',
      '/financial',
      '/platform/orders',
      '/platform/payments',
      '/platform/reports',
      '/platform/customers',
      '/platform/customers/usr_1',
      '/platform/merchants/mch_1',
    ]) {
      expect(redirectFor(session, elsewhere), elsewhere).toBe('/overview')
    }
  })

  it('sends an active platform admin to /platform, and lets it reach everything beneath', () => {
    const session: StaffMe = { kind: 'active', scope: 'platform' }
    for (const allowed of [
      '/platform',
      '/platform/merchants',
      '/platform/merchants/mch_1',
      '/platform/applications',
      '/platform/audit',
      '/platform/orders',
      '/platform/orders/NX-4K2P9',
      '/platform/payments',
      '/platform/reports',
      '/platform/customers',
      '/platform/customers/usr_1',
    ]) {
      expect(redirectFor(session, allowed), allowed).toBeNull()
    }
    for (const elsewhere of ['/', '/overview', '/products', '/orders/x', '/reports', '/inventory', '/finance', '/verify', '/platformx']) {
      expect(redirectFor(session, elsewhere), elsewhere).toBe('/platform')
    }
  })

  it('keeps the platform back office from a stranger and an enrolling session', () => {
    for (const path of ['/platform/orders', '/platform/payments', '/platform/reports', '/platform/customers/usr_1', '/platform/merchants/m']) {
      expect(redirectFor({ kind: null }, path), path).toBe('/signin')
      expect(redirectFor({ kind: 'enrolling' }, path), path).toBe('/enrol')
    }
  })

  it('sends an old /applications bookmark to where the page lives now', () => {
    const platform: StaffMe = { kind: 'active', scope: 'platform' }
    expect(redirectFor(platform, '/applications')).toBe('/platform/applications')
    // Nobody else gets there by the old address either.
    expect(redirectFor({ kind: null }, '/applications')).toBe('/signin')
    expect(
      redirectFor({ kind: 'active', scope: 'merchant', merchant: { name: 'A', slug: 'a', status: 'active' } }, '/applications'),
    ).toBe('/overview')
  })
})
