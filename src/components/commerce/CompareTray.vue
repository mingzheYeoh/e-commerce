<script setup lang="ts">
/**
 * The selection tray.
 *
 * Docked rather than a page of its own, because choosing what to compare
 * happens while browsing: sending a shopper somewhere else to review a list
 * they are still building costs them their place in the grid.
 *
 * It hides itself on /compare, where it would be a smaller copy of the page
 * behind it.
 */
import { computed } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { X, Scale } from 'lucide-vue-next'
import { useCompareStore, MAX_COMPARE } from '@/stores/compare'
import { categories } from '@/data/categories'

const compare = useCompareStore()
const route = useRoute()

const visible = computed(() => compare.ids.length > 0 && route.path !== '/compare')
const target = computed(() => ({ path: '/compare', query: { ids: compare.ids.join(',') } }))
const categoryLabel = computed(
  () => categories.find((c) => c.id === compare.category)?.label ?? '',
)
</script>

<template>
  <Transition
    enter-active-class="transition-transform duration-300"
    leave-active-class="transition-transform duration-200"
    enter-from-class="translate-y-full"
    leave-to-class="translate-y-full"
  >
    <div
      v-if="visible"
      class="fixed inset-x-0 bottom-0 z-40 border-t border-border-hairline bg-surface-1/95 backdrop-blur"
      role="region"
      aria-label="Products selected for comparison"
    >
      <div class="mx-auto flex max-w-[1600px] flex-wrap items-center gap-3 px-4 py-3 md:px-8">
        <Scale class="hidden h-4 w-4 shrink-0 text-text-secondary sm:block" aria-hidden="true" />

        <ul class="flex min-w-0 flex-1 items-center gap-2">
          <li v-for="item in compare.items" :key="item.id" class="relative shrink-0">
            <img
              :src="item.media.thumb"
              :alt="item.title"
              width="44"
              height="44"
              class="h-11 w-11 rounded border border-border-hairline object-cover"
            />
            <button
              type="button"
              class="absolute -right-1.5 -top-1.5 rounded-full border border-border-hairline bg-surface-2 p-0.5 text-text-secondary transition-colors hover:text-text-primary"
              :aria-label="`Remove ${item.title} from comparison`"
              @click="compare.remove(item.id)"
            >
              <X class="h-3 w-3" aria-hidden="true" />
            </button>
          </li>
          <!--
            Empty slots, so the cap is visible before it is hit rather than
            announced by a checkbox that stopped working.
          -->
          <li
            v-for="n in MAX_COMPARE - compare.ids.length"
            :key="`slot-${n}`"
            class="hidden h-11 w-11 shrink-0 rounded border border-dashed border-border-hairline sm:block"
            aria-hidden="true"
          ></li>
        </ul>

        <p class="nums shrink-0 text-xs text-text-secondary">
          {{ compare.ids.length }} of {{ MAX_COMPARE }}
          <span v-if="categoryLabel" class="hidden md:inline"> · {{ categoryLabel }}</span>
        </p>

        <button type="button" class="btn-ghost shrink-0 text-sm" @click="compare.clear()">
          Clear
        </button>

        <!--
          A single column compares nothing, so the action is disabled rather
          than leading to a page that explains it was a mistake.
        -->
        <RouterLink
          v-if="compare.ready"
          :to="target"
          class="btn-primary shrink-0 text-sm"
        >
          Compare
        </RouterLink>
        <span
          v-else
          class="btn-primary shrink-0 cursor-not-allowed text-sm opacity-40"
          aria-disabled="true"
          title="Pick one more to compare"
        >
          Compare
        </span>
      </div>
    </div>
  </Transition>
</template>
