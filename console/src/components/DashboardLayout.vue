<script setup lang="ts">
// The frame every signed-in page sits in: a sidebar from md up, a top bar with
// a menu below it, and the account name plus Sign out always in the header.
// Navigation only — which pages a session may reach is the worker's call,
// mirrored for UX by redirectFor.
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  ChartColumn,
  ClipboardCheck,
  LayoutDashboard,
  Boxes,
  Menu,
  Package,
  Receipt,
  ScrollText,
  ShoppingBag,
  Store,
  Users,
  Wallet,
  X,
} from 'lucide-vue-next'
import { me, merchantQueue, signOut } from '../api'

const props = defineProps<{ scope: 'merchant' | 'platform' }>()

const route = useRoute()
const router = useRouter()
const name = ref(props.scope === 'platform' ? 'NEXUSOHM Platform' : '')
const open = ref(false)

type NavItem = { to: string; label: string; icon: unknown; exact?: boolean; badge?: 'toShip' }

const NAV: Record<'merchant' | 'platform', NavItem[]> = {
  merchant: [
    { to: '/overview', label: 'Overview', icon: LayoutDashboard },
    { to: '/products', label: 'Products', icon: Package },
    { to: '/orders', label: 'Orders', icon: ShoppingBag, badge: 'toShip' },
    { to: '/inventory', label: 'Inventory', icon: Boxes },
    { to: '/reports', label: 'Reports', icon: ChartColumn },
    { to: '/finance', label: 'Finance', icon: Wallet },
  ],
  platform: [
    { to: '/platform', label: 'Overview', icon: LayoutDashboard, exact: true },
    { to: '/platform/orders', label: 'Orders', icon: ShoppingBag },
    { to: '/platform/payments', label: 'Payments', icon: Receipt },
    { to: '/platform/reports', label: 'Reports', icon: ChartColumn },
    { to: '/platform/customers', label: 'Customers', icon: Users },
    { to: '/platform/merchants', label: 'Merchants', icon: Store },
    { to: '/platform/applications', label: 'Applications', icon: ClipboardCheck },
    { to: '/platform/audit', label: 'Audit log', icon: ScrollText },
  ],
}
const nav = computed(() => NAV[props.scope])

// Flat routes, so router-link's own active class would not light Products on
// /products/abc. `exact` keeps /platform from lighting on every platform page.
const active = (item: { to: string; exact?: boolean }) =>
  route.path === item.to || (!item.exact && route.path.startsWith(`${item.to}/`))

/**
 * Parts still to ship, beside Orders. Re-read on every page change, so it
 * drops as soon as the order page marks one shipped and the merchant moves on.
 * A failed read shows no badge rather than a wrong number.
 */
const toShip = ref(0)
async function refreshQueue() {
  if (props.scope !== 'merchant') return
  const { body } = await merchantQueue().catch(() => ({ body: { error: 'offline' } }))
  toShip.value = 'toShip' in body ? body.toShip : 0
}

// A tap on a link closes the mobile menu by way of the route change.
watch(
  () => route.path,
  () => {
    open.value = false
    void refreshQueue()
  },
)

onMounted(async () => {
  void refreshQueue()
  const { body } = await me()
  if (body.kind === 'active' && body.scope === 'merchant') name.value = body.merchant.name
})

async function logout() {
  await signOut()
  await router.push('/')
}
</script>

<template>
  <div class="min-h-screen md:flex">
    <aside
      class="hidden border-r border-border-hairline bg-surface-1 md:sticky md:top-0 md:flex md:h-screen md:w-56 md:shrink-0 md:flex-col"
    >
      <div class="flex h-14 items-center border-b border-border-hairline px-5">
        <span class="font-display text-sm font-extrabold tracking-wide text-text-primary">NEXUSOHM</span>
        <span class="ml-2 text-xs text-text-muted">Console</span>
      </div>
      <nav class="flex flex-col gap-1 p-3" aria-label="Main">
        <router-link
          v-for="item in nav"
          :key="item.to"
          :to="item.to"
          class="flex items-center gap-3 rounded px-3 py-2 text-sm transition-colors"
          :class="active(item) ? 'bg-surface-2 text-text-primary' : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary'"
          :aria-current="active(item) ? 'page' : undefined"
        >
          <component :is="item.icon" class="h-4 w-4" :class="active(item) ? 'text-accent' : ''" aria-hidden="true" />
          {{ item.label }}
          <span
            v-if="item.badge && toShip"
            class="nums ml-auto rounded-full border border-accent-amber/40 px-1.5 text-[11px] text-accent-amber"
            :aria-label="`${toShip} to ship`"
          >{{ toShip }}</span>
        </router-link>
      </nav>
    </aside>

    <div class="min-w-0 flex-1">
      <header
        class="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border-hairline bg-void/90 px-4 backdrop-blur md:px-8"
      >
        <button
          class="-ml-1 rounded p-1.5 text-text-secondary hover:text-text-primary md:hidden"
          :aria-expanded="open"
          aria-controls="mobile-nav"
          :aria-label="open ? 'Close menu' : 'Open menu'"
          @click="open = !open"
        >
          <X v-if="open" class="h-5 w-5" aria-hidden="true" />
          <Menu v-else class="h-5 w-5" aria-hidden="true" />
        </button>
        <span class="min-w-0 flex-1 truncate font-display text-base font-bold text-text-primary">{{ name }}</span>
        <button class="btn-ghost px-3 py-1.5" @click="logout">Sign out</button>
      </header>

      <nav
        v-if="open"
        id="mobile-nav"
        class="sticky top-14 z-10 flex flex-col gap-1 border-b border-border-hairline bg-surface-1 p-3 md:hidden"
        aria-label="Main"
      >
        <router-link
          v-for="item in nav"
          :key="item.to"
          :to="item.to"
          class="flex items-center gap-3 rounded px-3 py-2.5 text-sm"
          :class="active(item) ? 'bg-surface-2 text-text-primary' : 'text-text-secondary'"
          :aria-current="active(item) ? 'page' : undefined"
        >
          <component :is="item.icon" class="h-4 w-4" :class="active(item) ? 'text-accent' : ''" aria-hidden="true" />
          {{ item.label }}
          <span
            v-if="item.badge && toShip"
            class="nums ml-auto rounded-full border border-accent-amber/40 px-1.5 text-[11px] text-accent-amber"
            :aria-label="`${toShip} to ship`"
          >{{ toShip }}</span>
        </router-link>
      </nav>

      <main class="mx-auto max-w-6xl px-4 py-6 md:px-8 md:py-8">
        <slot />
      </main>
    </div>
  </div>
</template>
