import { describe, it, expect, vi, afterEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import WelcomeTransition from './WelcomeTransition.vue'
import { useUiStore } from '@/stores/ui'

afterEach(() => vi.useRealTimers())

describe('WelcomeTransition', () => {
  it('greets, changes the route while covering the page, then lifts', async () => {
    vi.useFakeTimers()
    const pinia = createPinia()
    setActivePinia(pinia)
    const router = createRouter({
      history: createMemoryHistory(),
      routes: ['/', '/account', '/checkout'].map((path) => ({ path, component: { template: '<div />' } })),
    })
    await router.push('/account')
    const w = mount(WelcomeTransition, { global: { plugins: [pinia, router] } })
    const ui = useUiStore()

    ui.welcome = { message: 'Welcome back, Ada', to: '/checkout' }
    await flushPromises()
    expect(w.text()).toContain('Welcome back, Ada')
    // Still covering: nothing moves before the greeting has had its moment.
    expect(router.currentRoute.value.path).toBe('/account')

    await vi.runAllTimersAsync()
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/checkout')
    expect(ui.welcome).toBeNull()
  })
})
