import { describe, it, expect, vi } from 'vitest'
import { shouldRunParticles, hasWebGL } from './hero-fallback'

const capable = {
  reducedMotion: false,
  width: 1440,
  saveData: false,
  webgl: () => true,
}

describe('three.js hero fallback', () => {
  it('runs on a capable desktop', () => {
    expect(shouldRunParticles(capable)).toBe(true)
  })

  it('falls back for reduced motion', () => {
    expect(shouldRunParticles({ ...capable, reducedMotion: true })).toBe(false)
  })

  it('falls back below 768px, and runs at exactly 768px', () => {
    expect(shouldRunParticles({ ...capable, width: 767 })).toBe(false)
    expect(shouldRunParticles({ ...capable, width: 768 })).toBe(true)
  })

  it('falls back when the visitor asked to save data', () => {
    expect(shouldRunParticles({ ...capable, saveData: true })).toBe(false)
  })

  it('falls back without WebGL', () => {
    expect(shouldRunParticles({ ...capable, webgl: () => false })).toBe(false)
  })

  it('probes WebGL only when everything else already allows it', () => {
    // The probe creates a GL context; a phone or a reduced-motion visitor
    // should never pay for one.
    const webgl = vi.fn(() => true)
    shouldRunParticles({ ...capable, width: 400, webgl })
    shouldRunParticles({ ...capable, reducedMotion: true, webgl })
    expect(webgl).not.toHaveBeenCalled()
  })

  it('reports no WebGL in an environment without it (jsdom)', () => {
    expect(hasWebGL()).toBe(false)
  })
})
