import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useUiStore } from './ui'

describe('currency preference', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('survives a reload', () => {
    // Picking MYR and then opening any link that reloads the page used to put
    // every price back in USD.
    useUiStore().setCurrency('MYR')
    setActivePinia(createPinia())
    expect(useUiStore().currency).toBe('MYR')
  })

  it('ignores a stored value that is not a supported currency', () => {
    localStorage.setItem('nexus:currency', 'XYZ')
    expect(useUiStore().currency).toBe('USD')
  })
})
