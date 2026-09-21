<script setup lang="ts">
/**
 * Side-by-side comparison, one category at a time.
 *
 * The URL is the source of truth on arrival, so a comparison can be sent to
 * someone — matching the site's rule that view state lives in the query rather
 * than in a store nobody else can see. What arrives is validated rather than
 * trusted: a hand-edited `?ids=` gives a smaller table, never a broken page.
 */
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { X, Check } from 'lucide-vue-next'
import { useCompareStore, MAX_COMPARE } from '@/stores/compare'
import { useCartStore } from '@/stores/cart'
import { useCurrency } from '@/composables/useCurrency'
import { buildRows } from '@/lib/compare-rows'
import { categories } from '@/data/categories'
import { products } from '@/data/products'

const route = useRoute()
const router = useRouter()
const compare = useCompareStore()
const cart = useCartStore()
const { format } = useCurrency()

const differencesOnly = ref(false)

const queryIds = computed(() => String(route.query.ids ?? '').split(',').filter(Boolean))

/*
 * A link that names products wins; a bare /compare does not.
 *
 * Without that second half, opening /compare straight from the address bar
 * would read "no ids" as "clear the selection" and wipe a tray the shopper
 * spent the last five minutes filling.
 */
watch(
  queryIds,
  (ids) => {
    if (!ids.length) return
    if (ids.join(',') !== compare.ids.join(',')) compare.setFromIds(ids)
  },
  { immediate: true },
)

/*
 * And the address bar is kept honest about what is on screen. `immediate`
 * matters: the watcher above has already rewritten the store by the time this
 * one is created, so without it a URL carrying a delisted id, a second category
 * or a fifth product would keep advertising products the table is not showing.
 *
 * Replace, not push, so removing a column does not turn Back into a walk
 * through every intermediate selection.
 */
watch(
  () => compare.ids,
  (ids) => {
    if (ids.join(',') === queryIds.value.join(',')) return
    router.replace(ids.length ? { path: '/compare', query: { ids: ids.join(',') } } : '/compare')
  },
  { immediate: true },
)

const rows = computed(() => buildRows(compare.items))

/*
 * "Differences only" also drops rows a single product answers alone. Those read
 * as a difference but are an absence, and the published-spec union is mostly
 * made of them — four peripherals produce 27 labels, none answered by all four.
 */
const shown = computed(() =>
  differencesOnly.value ? rows.value.filter((r) => !r.same && r.comparable) : rows.value,
)
const measured = computed(() => shown.value.filter((r) => r.group === 'measured'))
const published = computed(() => shown.value.filter((r) => r.group === 'spec'))
const foldable = computed(() => rows.value.filter((r) => r.same || !r.comparable).length)
const specCount = computed(() => rows.value.filter((r) => r.group === 'spec').length)

const categoryLabel = computed(
  () => categories.find((c) => c.id === compare.category)?.label ?? 'products',
)

/* --------------------------------------------------------------- pickers */

/**
 * What one slot may be changed to.
 *
 * Everything already chosen in another slot is out, so the list cannot produce
 * a duplicate column. Once a category is locked only that category is offered —
 * the store would refuse a cross-category swap anyway, and a dropdown whose
 * options silently do nothing is worse than one that does not offer them.
 */
function optionsFor(index: number) {
  const taken = new Set(compare.ids.filter((_, i) => i !== index))
  const pool = compare.category
    ? products.filter((p) => p.category === compare.category)
    : products

  return categories
    .map((c) => ({
      label: c.label,
      items: pool
        .filter((p) => p.category === c.id && !taken.has(p.id))
        .sort((a, b) => a.title.localeCompare(b.title)),
    }))
    .filter((g) => g.items.length > 0)
}

/**
 * The slots, in order: every chosen product, then one open slot, then nothing.
 *
 * Only one open slot is offered at a time. Four dropdowns reading "Add a
 * product" is a form; one is an invitation, and the others appear as they are
 * earned.
 */
const slots = computed(() =>
  Array.from({ length: MAX_COMPARE }, (_, i) => ({
    index: i,
    id: compare.ids[i] ?? '',
    open: i === compare.ids.length,
  })).filter((s) => s.id || s.open),
)

function choose(index: number, event: Event) {
  const select = event.target as HTMLSelectElement
  const id = select.value
  if (!id) return
  // Refused swaps leave the store alone, so the select is put back to what the
  // store actually holds rather than showing a choice that did not take.
  if (!compare.setAt(index, id)) select.value = compare.ids[index] ?? ''
}

const cell = (value: number | string | null, money: boolean, unit?: string) => {
  // An unpublished figure is a dash. Rendering it as 0 would report a claim the
  // manufacturer never made.
  if (value === null) return '—'
  // The one money row (Price) is priceMinor, already in minor units.
  if (money && typeof value === 'number') return format(value)
  return `${value}${unit ?? ''}`
}
</script>

<template>
  <div class="pt-16">
    <div class="mx-auto max-w-[1600px] px-4 py-10 md:px-8 md:py-14">
      <h1 class="text-2xl font-bold md:text-3xl">Compare</h1>
      <p class="mt-2 max-w-2xl text-sm text-text-secondary">
        Up to {{ MAX_COMPARE }} products from one category. Pick them here, or tick
        <span class="whitespace-nowrap">“Compare”</span> on any product while you browse.
      </p>

      <!--
        The pickers, above the table rather than inside it.

        Choosing what to compare used to be possible only somewhere else — you
        arrived here with a selection already made, and changing your mind meant
        going back to the grid. A column is a dropdown now, so a comparison can
        be built and rebuilt without leaving the answer.
      -->
      <div class="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div
          v-for="slot in slots"
          :key="slot.index"
          class="rounded-card border bg-surface-1 p-2"
          :class="slot.open ? 'border-dashed border-border-hairline' : 'border-border-hairline'"
        >
          <div class="flex items-center gap-1.5">
            <label class="sr-only" :for="`slot-${slot.index}`">
              {{ slot.open ? 'Add a product' : `Product ${slot.index + 1}` }}
            </label>
            <select
              :id="`slot-${slot.index}`"
              :value="slot.id"
              class="input min-w-0 flex-1 truncate"
              @change="choose(slot.index, $event)"
            >
              <option v-if="slot.open" value="">Add a product…</option>
              <optgroup
                v-for="group in optionsFor(slot.index)"
                :key="group.label"
                :label="group.label"
              >
                <option v-for="p in group.items" :key="p.id" :value="p.id">{{ p.title }}</option>
              </optgroup>
            </select>
            <button
              v-if="!slot.open"
              type="button"
              class="shrink-0 rounded p-2 text-text-muted transition-colors hover:text-text-primary"
              :aria-label="`Remove product ${slot.index + 1} from comparison`"
              @click="compare.remove(slot.id)"
            >
              <X class="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>

      <!-- Fewer than two columns is not a comparison; say so plainly. -->
      <div v-if="!compare.ready" class="mt-6 max-w-lg">
        <p class="text-text-secondary">
          {{
            compare.ids.length === 1
              ? 'Pick one more product to put it side by side.'
              : 'Nothing selected yet.'
          }}
        </p>
        <RouterLink to="/shop" class="btn-ghost mt-4 inline-flex">Browse the grid instead</RouterLink>
      </div>

      <template v-else>
        <div class="mt-8 flex flex-wrap items-center gap-4">
          <p class="text-sm text-text-secondary">
            {{ compare.items.length }} {{ categoryLabel.toLowerCase() }}, on their published figures
          </p>
          <label
            v-if="foldable > 0"
            class="flex cursor-pointer items-center gap-2 text-sm"
            title="Hides rows where every column agrees, and rows only one product answers"
          >
            <input v-model="differencesOnly" type="checkbox" class="accent-accent" />
            <span class="text-text-secondary">
              Differences only
              <span class="nums text-text-muted">(folds {{ foldable }} of {{ rows.length }})</span>
            </span>
          </label>
        </div>

        <div class="mt-6 overflow-x-auto">
          <table class="w-full min-w-[640px] border-collapse text-sm">
            <caption class="sr-only">
              {{ categoryLabel }} compared on price, rating and published specifications
            </caption>
            <thead>
              <tr>
                <th scope="col" class="sticky left-0 z-10 w-36 bg-void p-3 text-left align-bottom">
                  <span class="sr-only">Specification</span>
                </th>
                <th
                  v-for="item in compare.items"
                  :key="item.id"
                  scope="col"
                  class="min-w-[180px] p-3 align-bottom text-left font-normal"
                >
                  <div class="relative rounded-card border border-border-hairline bg-surface-1 p-3">
                    <button
                      type="button"
                      class="absolute right-2 top-2 rounded p-1 text-text-muted transition-colors hover:text-text-primary"
                      :aria-label="`Remove ${item.title} from comparison`"
                      @click="compare.remove(item.id)"
                    >
                      <X class="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                    <RouterLink :to="`/product/${item.id}`" class="block">
                      <img
                        :src="item.media.thumb"
                        :alt="item.title"
                        width="72"
                        height="72"
                        class="h-16 w-16 rounded bg-surface-2 object-cover"
                      />
                      <span class="mt-2 block pr-5 font-semibold leading-snug hover:text-accent">
                        {{ item.title }}
                      </span>
                    </RouterLink>
                    <button
                      type="button"
                      class="btn-ghost mt-3 w-full text-center text-xs disabled:cursor-not-allowed disabled:opacity-40"
                      :disabled="!item.inStock"
                      @click="cart.add(item)"
                    >
                      {{ item.inStock ? 'Add to bag' : 'Out of stock' }}
                    </button>
                  </div>
                </th>
              </tr>
            </thead>

            <tbody>
              <tr
                v-for="row in measured"
                :key="`measured-${row.label}`"
                class="border-t border-border-hairline"
              >
                <th
                  scope="row"
                  class="sticky left-0 z-10 bg-void p-3 text-left align-top font-medium text-text-secondary"
                >
                  {{ row.label }}
                </th>
                <td
                  v-for="(c, i) in row.cells"
                  :key="i"
                  class="p-3 align-top"
                  :class="c.value === null && 'text-text-muted'"
                >
                  <span class="nums" :class="c.best && 'font-semibold text-accent-green'">
                    {{ cell(c.value, row.money, row.unit) }}
                  </span>
                  <!--
                    The tick is the only thing that says "better", so it appears
                    only on rows where better is a fact: price, capacity, rating.
                    Screen size has no winner and gets none.
                  -->
                  <Check
                    v-if="c.best"
                    class="ml-1 inline h-3.5 w-3.5 text-accent-green"
                    aria-label="best in this row"
                  />
                </td>
              </tr>
            </tbody>

            <!--
              The manufacturers' own lines, verbatim. Kept apart from the rows
              above because a label can honestly appear in both — "Storage" is a
              number up there and "256GB / 512GB / 1TB / 2TB" down here — and
              running them together would read as the table contradicting
              itself.
            -->
            <tbody v-if="published.length">
              <tr class="border-t border-border-hairline">
                <th
                  scope="colgroup"
                  :colspan="compare.items.length + 1"
                  class="p-3 pt-8 text-left text-xs font-semibold uppercase tracking-wide text-text-muted"
                >
                  All published specifications
                </th>
              </tr>
              <tr
                v-for="row in published"
                :key="`spec-${row.label}`"
                class="border-t border-border-hairline"
              >
                <th
                  scope="row"
                  class="sticky left-0 z-10 bg-void p-3 text-left align-top font-medium text-text-secondary"
                >
                  {{ row.label }}
                </th>
                <td
                  v-for="(c, i) in row.cells"
                  :key="i"
                  class="p-3 align-top leading-relaxed"
                  :class="c.value === null ? 'text-text-muted' : 'text-text-secondary'"
                >
                  {{ c.value ?? '—' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <p class="mt-6 max-w-2xl text-xs text-text-muted">
          A dash means the manufacturer publishes no figure for that row — not that the product
          lacks it. Highlights mark the best value only where one direction is genuinely better;
          screen size, ports and free text are shown without a verdict. The
          {{ specCount }} published rows are reproduced as written, so two makers describing the
          same part differently get two rows rather than a guess that they meant the same thing.
        </p>

        <!-- Adding a column is the dropdown row at the top now, so this is not
             repeated here; what is left is the way out of the category lock. -->
        <div class="mt-6 flex flex-wrap gap-3">
          <button type="button" class="btn-ghost" @click="compare.clear()">
            Clear all · start a different category
          </button>
          <RouterLink to="/shop" class="btn-ghost">Back to the grid</RouterLink>
        </div>
      </template>
    </div>
  </div>
</template>
