import { describe, it, expect } from 'vitest'
import { START_LOCATION, type RouteLocationNormalized } from 'vue-router'
import { router, whenPresent } from './index'

const behave = router.options.scrollBehavior!
const at = (path: string) => ({ path }) as RouteLocationNormalized
const saved = { left: 0, top: 1200 }

describe('scrollBehavior', () => {
  it('opens a reloaded page at the top even though a position was saved', () => {
    // The router keeps scroll positions in history.state, so a refresh
    // arrives with one; using it reopened the page halfway down.
    expect(behave(at('/'), START_LOCATION, saved)).toEqual({ top: 0 })
  })

  it('still restores the position on back and forward', () => {
    expect(behave(at('/'), at('/shop'), saved)).toEqual(saved)
  })

  it('lands at the top of a newly visited page', () => {
    expect(behave(at('/shop'), at('/'), null)).toEqual({ top: 0 })
  })
})

describe('scrollBehavior with a hash', () => {
  const hashed = { path: '/product/x', hash: '#reviews' } as RouteLocationNormalized

  it('scrolls to the element once the lazy page has rendered it, clear of the navbar', async () => {
    const pending = behave(hashed, at('/account'), null)
    const section = document.createElement('section')
    section.id = 'reviews'
    setTimeout(() => document.body.append(section), 120)
    expect(await pending).toEqual({ el: '#reviews', top: 80 })
    section.remove()
  })

  it('reports false when the element never appears', async () => {
    expect(await whenPresent('#nope', 100)).toBe(false)
  })
})
