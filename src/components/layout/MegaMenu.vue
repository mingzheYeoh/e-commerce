<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { ChevronDown, ArrowRight } from 'lucide-vue-next'
import { categories } from '@/data/categories'
import { brands } from '@/data/brands'
import { products } from '@/data/products'

const route = useRoute()
const open = ref(false)
const root = ref<HTMLElement | null>(null)

const countIn = (id: string) => products.filter((p) => p.category === id).length

// Close on navigation, on Escape, and on a click outside. A menu that survives
// a route change is the classic way this component goes wrong.
watch(() => route.fullPath, () => (open.value = false))

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') open.value = false
}
function onPointerDown(event: PointerEvent) {
  if (open.value && root.value && !root.value.contains(event.target as Node)) open.value = false
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown)
  document.addEventListener('pointerdown', onPointerDown)
})
onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown)
  document.removeEventListener('pointerdown', onPointerDown)
})
</script>

<template>
  <div ref="root" class="relative" @mouseleave="open = false">
    <button
      type="button"
      class="flex h-10 items-center gap-1.5 rounded px-3 text-sm font-medium transition-colors"
      :class="open ? 'bg-surface-2 text-text-primary' : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary'"
      :aria-expanded="open"
      aria-haspopup="true"
      @click="open = !open"
      @mouseenter="open = true"
    >
      Shop
      <ChevronDown class="h-3.5 w-3.5 transition-transform" :class="open && 'rotate-180'" aria-hidden="true" />
    </button>

    <Transition
      enter-from-class="opacity-0 -translate-y-1"
      leave-to-class="opacity-0"
      enter-active-class="transition duration-150"
      leave-active-class="transition duration-100"
    >
      <div
        v-if="open"
        class="absolute left-1/2 top-full z-50 w-[min(92vw,760px)] -translate-x-1/2 pt-2"
      >
        <div class="card grid gap-8 p-6 shadow-2xl shadow-black/60 md:grid-cols-[1fr_1.4fr]">
          <!-- Categories -->
          <div>
            <p class="mb-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
              Categories
            </p>
            <ul class="space-y-1">
              <li v-for="category in categories" :key="category.id">
                <RouterLink
                  :to="{ path: '/shop', query: { category: category.id } }"
                  class="flex items-center justify-between rounded px-2 py-2 text-sm text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
                >
                  {{ category.label }}
                  <span class="nums text-xs text-text-muted">{{ countIn(category.id) }}</span>
                </RouterLink>
              </li>
            </ul>
          </div>

          <!-- Brands -->
          <div>
            <p class="mb-3 text-xs font-semibold uppercase tracking-wide text-text-muted">Brands</p>
            <ul class="grid grid-cols-2 gap-x-4 gap-y-1">
              <li v-for="brand in brands" :key="brand.id">
                <RouterLink
                  :to="{ path: '/shop', query: { brand: brand.id } }"
                  class="block truncate rounded px-2 py-1.5 text-sm text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
                >
                  {{ brand.name }}
                </RouterLink>
              </li>
            </ul>

            <RouterLink
              to="/shop"
              class="mt-4 flex items-center gap-1.5 px-2 text-sm font-medium text-accent transition-colors hover:text-accent-hover"
            >
              View all {{ products.length }} products
              <ArrowRight class="h-4 w-4" aria-hidden="true" />
            </RouterLink>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>
