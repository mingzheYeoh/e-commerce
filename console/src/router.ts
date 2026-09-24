import { createRouter, createWebHistory } from 'vue-router'
import { me, type StaffMe } from './api'
import Apply from './pages/Apply.vue'
import SignIn from './pages/SignIn.vue'
import Enrol from './pages/Enrol.vue'
import Verify from './pages/Verify.vue'
import Products from './pages/Products.vue'
import Applications from './pages/Applications.vue'

export const routes = [
  { path: '/apply', name: 'apply', component: Apply },
  { path: '/signin', name: 'signin', component: SignIn },
  { path: '/enrol', name: 'enrol', component: Enrol },
  { path: '/verify', name: 'verify', component: Verify },
  { path: '/products', name: 'products', component: Products },
  { path: '/applications', name: 'applications', component: Applications },
  // Neither is a real destination: the guard below redirects away from both
  // for every `me` shape, so the component here is never actually shown.
  { path: '/', name: 'root', component: SignIn },
  { path: '/:pathMatch(.*)*', name: 'not-found', component: SignIn },
]

/**
 * Where a session in this `me` shape belongs, given where it is headed —
 * or null when `to` is already the right place.
 *
 * Pure on purpose: this is what the test file exercises directly, without a
 * router or a fetch mock. It is UX only — every boundary it enforces is one
 * the worker already enforces on the request itself; this just stops the SPA
 * from flashing a page a following request would refuse anyway.
 */
export function redirectFor(session: StaffMe, to: string): string | null {
  if (session.kind === null) return to === '/apply' || to === '/signin' ? null : '/signin'
  if (session.kind === 'enrolling') return to === '/enrol' || to === '/verify' ? null : '/enrol'
  const home = session.scope === 'merchant' ? '/products' : '/applications'
  return to === home ? null : home
}

export const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.beforeEach(async (to) => {
  const { body } = await me()
  return redirectFor(body, to.path) ?? true
})
