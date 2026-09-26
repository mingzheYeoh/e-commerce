import { createRouter, createWebHistory } from 'vue-router'
import { me, type StaffMe } from './api'
import Apply from './pages/Apply.vue'
import SignIn from './pages/SignIn.vue'
import Enrol from './pages/Enrol.vue'
import Verify from './pages/Verify.vue'
import Overview from './pages/Overview.vue'
import Products from './pages/Products.vue'
import ProductNew from './pages/ProductNew.vue'
import ProductEdit from './pages/ProductEdit.vue'
import Orders from './pages/Orders.vue'
import OrderDetail from './pages/OrderDetail.vue'
import Reports from './pages/Reports.vue'
import Inventory from './pages/Inventory.vue'
import Finance from './pages/Finance.vue'
import PlatformOverview from './pages/PlatformOverview.vue'
import Merchants from './pages/Merchants.vue'
import Applications from './pages/Applications.vue'
import AuditLog from './pages/AuditLog.vue'
import MerchantDetail from './pages/MerchantDetail.vue'
import PlatformOrders from './pages/PlatformOrders.vue'
import PlatformOrderDetail from './pages/PlatformOrderDetail.vue'
import Payments from './pages/Payments.vue'
import PlatformReports from './pages/PlatformReports.vue'
import Customers from './pages/Customers.vue'
import CustomerDetail from './pages/CustomerDetail.vue'

/** Which dashboard frame a page sits in. Pages without one (sign-in, enrol) stand alone. */
declare module 'vue-router' {
  interface RouteMeta {
    shell?: 'merchant' | 'platform'
  }
}

const merchant = { shell: 'merchant' } as const
const platform = { shell: 'platform' } as const

export const routes = [
  { path: '/apply', name: 'apply', component: Apply },
  { path: '/signin', name: 'signin', component: SignIn },
  { path: '/enrol', name: 'enrol', component: Enrol },
  { path: '/verify', name: 'verify', component: Verify },
  { path: '/overview', name: 'overview', component: Overview, meta: merchant },
  { path: '/products', name: 'products', component: Products, meta: merchant },
  { path: '/products/new', name: 'product-new', component: ProductNew, meta: merchant },
  { path: '/products/:id', name: 'product-edit', component: ProductEdit, props: true, meta: merchant },
  { path: '/orders', name: 'orders', component: Orders, meta: merchant },
  { path: '/orders/:id', name: 'order', component: OrderDetail, props: true, meta: merchant },
  { path: '/reports', name: 'reports', component: Reports, meta: merchant },
  { path: '/inventory', name: 'inventory', component: Inventory, meta: merchant },
  { path: '/finance', name: 'finance', component: Finance, meta: merchant },
  { path: '/platform', name: 'platform', component: PlatformOverview, meta: platform },
  { path: '/platform/merchants', name: 'merchants', component: Merchants, meta: platform },
  { path: '/platform/merchants/:id', name: 'merchant', component: MerchantDetail, props: true, meta: platform },
  { path: '/platform/orders', name: 'platform-orders', component: PlatformOrders, meta: platform },
  { path: '/platform/orders/:id', name: 'platform-order', component: PlatformOrderDetail, props: true, meta: platform },
  { path: '/platform/payments', name: 'payments', component: Payments, meta: platform },
  { path: '/platform/reports', name: 'platform-reports', component: PlatformReports, meta: platform },
  { path: '/platform/customers', name: 'customers', component: Customers, meta: platform },
  { path: '/platform/customers/:id', name: 'customer', component: CustomerDetail, props: true, meta: platform },
  { path: '/platform/applications', name: 'applications', component: Applications, meta: platform },
  { path: '/platform/audit', name: 'audit', component: AuditLog, meta: platform },
  // Neither is a real destination: the guard below redirects away from both
  // for every `me` shape, so the component here is never actually shown.
  { path: '/', name: 'root', component: SignIn },
  { path: '/:pathMatch(.*)*', name: 'not-found', component: SignIn },
]

/** A merchant's pages: each of these and anything beneath it (/products/new, /orders/:id). */
const MERCHANT_PAGES = ['/overview', '/products', '/orders', '/reports', '/inventory', '/finance']

/** `to` is `base` itself or anywhere beneath it. */
const within = (to: string, base: string) => to === base || to.startsWith(`${base}/`)

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
  // A merchant's home is /overview; the products and orders subtrees (lists,
  // /new, and /:id) are theirs too.
  if (session.scope === 'merchant') {
    return MERCHANT_PAGES.some((base) => within(to, base)) ? null : '/overview'
  }
  // Applications moved under /platform; an old bookmark still lands on it.
  if (to === '/applications') return '/platform/applications'
  return within(to, '/platform') ? null : '/platform'
}

export const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.beforeEach(async (to) => {
  // A failed /me (offline, worker down) is treated as signed out rather than
  // aborting navigation onto a blank page; the worker still decides access.
  const session = await me().then(
    (r) => r.body,
    () => ({ kind: null }) as const,
  )
  return redirectFor(session, to.path) ?? true
})
