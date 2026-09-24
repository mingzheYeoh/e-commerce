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

  it('sends an active merchant to /products and nowhere else', () => {
    const session: StaffMe = {
      kind: 'active',
      scope: 'merchant',
      merchant: { name: 'Acme', slug: 'acme', status: 'active' },
    }
    expect(redirectFor(session, '/products')).toBeNull()
    expect(redirectFor(session, '/products/new')).toBeNull()
    expect(redirectFor(session, '/products/abc123')).toBeNull()
    expect(redirectFor(session, '/applications')).toBe('/products')
    expect(redirectFor(session, '/signin')).toBe('/products')
    expect(redirectFor(session, '/enrol')).toBe('/products')
  })

  it('sends an active platform admin to /applications and nowhere else', () => {
    const session: StaffMe = { kind: 'active', scope: 'platform' }
    expect(redirectFor(session, '/applications')).toBeNull()
    expect(redirectFor(session, '/products')).toBe('/applications')
    expect(redirectFor(session, '/products/new')).toBe('/applications')
    expect(redirectFor(session, '/verify')).toBe('/applications')
  })
})
