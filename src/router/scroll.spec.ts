import { describe, it, expect } from 'vitest'
import { START_LOCATION, type RouteLocationNormalized } from 'vue-router'
import { router } from './index'

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
