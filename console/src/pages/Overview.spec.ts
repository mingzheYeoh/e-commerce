import { describe, it, expect, vi, afterEach } from 'vitest'
import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils'
import Overview from './Overview.vue'

afterEach(() => vi.unstubAllGlobals())

describe('the overview', () => {
  it('says the server could not be reached, rather than Loading forever, when every fetch rejects', async () => {
    // The real API layer: its call() is what turns a rejected fetch into an error.
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))))
    const w = mount(Overview, { global: { stubs: { RouterLink: RouterLinkStub } } })
    await flushPromises()
    expect(w.text()).toContain("Couldn't reach the server")
    expect(w.text()).not.toContain('Loading…')
  })
})
