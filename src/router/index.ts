import { createRouter, createWebHistory, START_LOCATION } from 'vue-router'

/** Resolves true once `selector` matches an element, false after `ms`. */
export function whenPresent(selector: string, ms = 2500): Promise<boolean> {
  const end = Date.now() + ms
  return new Promise((resolve) => {
    const look = () => {
      let el: Element | null = null
      try {
        el = document.querySelector(selector)
      } catch {
        // A hash that is not a valid selector cannot match anything.
      }
      if (el) resolve(true)
      else if (Date.now() > end) resolve(false)
      else setTimeout(look, 50)
    }
    look()
  })
}

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: () => import('@/pages/HomePage.vue') },
    { path: '/shop', name: 'shop', component: () => import('@/pages/ShopPage.vue') },
    { path: '/ask', name: 'ask', component: () => import('@/pages/AskPage.vue') },
    { path: '/cart', name: 'cart', component: () => import('@/pages/CartPage.vue') },
    { path: '/compare', name: 'compare', component: () => import('@/pages/ComparePage.vue') },
    { path: '/account', name: 'account', component: () => import('@/pages/AccountPage.vue') },
    { path: '/verify', name: 'verify', component: () => import('@/pages/VerifyPage.vue') },
    { path: '/reset', name: 'reset', component: () => import('@/pages/ResetPage.vue') },
    { path: '/checkout', name: 'checkout', component: () => import('@/pages/CheckoutPage.vue') },
    {
      path: '/order/:id',
      name: 'order',
      component: () => import('@/pages/OrderPage.vue'),
      props: true,
    },
    {
      path: '/product/:id',
      name: 'product',
      component: () => import('@/pages/ProductPage.vue'),
      props: true,
    },
    {
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      component: () => import('@/pages/NotFoundPage.vue'),
    },
  ],
  // Land at the top of a new page, but restore position on back/forward. A
  // reload is the one navigation that carries a saved position yet should not
  // use it: the router keeps it in history.state, so a refresh would reopen
  // halfway down the page.
  // A hash (the order page's "Write a review") scrolls to its element, below
  // the fixed navbar. The target lives in a lazily loaded page, so wait for it
  // to exist; giving up after a couple of seconds lands at the top rather than
  // never resolving. The jump is instant: Lenis picks up the native scroll.
  scrollBehavior: (to, from, saved) => {
    if (to.hash) return whenPresent(to.hash).then((found) => (found ? { el: to.hash, top: 80 } : { top: 0 }))
    return from === START_LOCATION ? { top: 0 } : (saved ?? { top: 0 })
  },
})
