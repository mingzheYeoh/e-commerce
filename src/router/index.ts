import { createRouter, createWebHistory } from 'vue-router'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: () => import('@/pages/HomePage.vue') },
    { path: '/shop', name: 'shop', component: () => import('@/pages/ShopPage.vue') },
    { path: '/ask', name: 'ask', component: () => import('@/pages/AskPage.vue') },
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
