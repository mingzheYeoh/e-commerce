import { createRouter, createWebHistory } from 'vue-router'

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
  // Land at the top of a new page, but restore position on back/forward.
  scrollBehavior: (_to, _from, saved) => saved ?? { top: 0 },
})
