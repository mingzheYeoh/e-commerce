import { describe, it, expect, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import RollingText from './RollingText.vue'

afterEach(() => {
  delete document.documentElement.dataset.motion
})

describe('RollingText', () => {
  it('gives screen readers the whole figure once, and a rolling column per digit', () => {
    const w = mount(RollingText, { props: { text: '$5,446.00' } })
    expect(w.get('.sr-only').text()).toBe('$5,446.00')
    expect(w.findAll('.rolling-col').map((c) => c.attributes('data-digit')).join('')).toBe('544600')
    // $ , and . are printed as they are.
    expect(w.findAll('.rolling-char').map((c) => c.text()).join('')).toBe('$,.')
  })

  it('keys digits by place from the right, so a growing number keeps its ones column', async () => {
    const w = mount(RollingText, { props: { text: '99' } })
    const ones = w.findAll('.rolling-col').at(-1)!.element
    await w.setProps({ text: '100' })
    expect(w.findAll('.rolling-col').at(-1)!.element).toBe(ones)
    expect(w.get('.sr-only').text()).toBe('100')
  })

  it('prints the text and nothing else under reduced motion', () => {
    document.documentElement.dataset.motion = 'reduced'
    const w = mount(RollingText, { props: { text: '18 active' } })
    expect(w.text()).toBe('18 active')
    expect(w.findAll('.rolling-col')).toHaveLength(0)
  })
})
