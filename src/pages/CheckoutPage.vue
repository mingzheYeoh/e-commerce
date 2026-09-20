<script setup lang="ts">
/**
 * The three-step wizard.
 *
 * A step cannot be reached until the ones before it validate — `highestReachable`
 * is enforced here rather than by hiding buttons, so a bookmarked `?step=3`
 * lands on the first incomplete step instead of a payment form with no address
 * behind it.
 */
import { computed, onMounted } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { Check, Lock, AlertCircle, CreditCard } from 'lucide-vue-next'
import { useCartStore } from '@/stores/cart'
import { useCheckoutStore } from '@/stores/checkout'
import { useCurrency } from '@/composables/useCurrency'
import { SHIPPING, TAX_RATES, type ShipMethod } from '@/lib/money'
import OrderSummary from '@/components/checkout/OrderSummary.vue'

const cart = useCartStore()
const checkout = useCheckoutStore()
const router = useRouter()
const { format } = useCurrency()

const STEPS = [
  { n: 1 as const, label: 'Delivery' },
  { n: 2 as const, label: 'Shipping' },
  { n: 3 as const, label: 'Payment' },
]

const METHODS = Object.entries(SHIPPING) as [ShipMethod, (typeof SHIPPING)[ShipMethod]][]

/** Sorted so the free states are visible; a $0.00 tax line proves the rate follows the address. */
const STATES = Object.keys(TAX_RATES).sort()

const canPlace = computed(() => checkout.stepValid(3) && cart.items.length > 0)

onMounted(() => {
  if (!cart.items.length) router.replace('/cart')
})

async function place() {
  const result = await checkout.place()
  if (result.ok) router.push(`/order/${result.id}`)
}
</script>

<template>
  <div class="pt-16">
    <div class="mx-auto max-w-[1600px] px-4 py-10 md:px-8 md:py-14">
      <nav class="mb-8 text-sm text-text-secondary" aria-label="Breadcrumb">
        <RouterLink to="/cart" class="transition-colors hover:text-text-primary">Cart</RouterLink>
        <span class="mx-2 text-text-muted">/</span>
        <span class="text-text-primary">Checkout</span>
      </nav>

      <!-- Progress -->
      <ol class="mb-10 flex items-center gap-2" aria-label="Checkout progress">
        <li v-for="(s, i) in STEPS" :key="s.n" class="flex flex-1 items-center gap-2">
          <button
            type="button"
            class="flex items-center gap-2 text-sm transition-colors"
            :class="checkout.step === s.n ? 'text-text-primary' : 'text-text-muted hover:text-text-secondary'"
            @click="checkout.goTo(s.n)"
          >
            <span
              class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
              :class="
                checkout.step > s.n
                  ? 'bg-accent-green/20 text-accent-green'
                  : checkout.step === s.n
                    ? 'bg-accent text-white'
                    : 'bg-surface-2 text-text-muted'
              "
            >
              <Check v-if="checkout.step > s.n" class="h-3 w-3" aria-hidden="true" />
              <template v-else>{{ s.n }}</template>
            </span>
            <span class="hidden font-medium sm:inline">{{ s.label }}</span>
          </button>
          <span v-if="i < STEPS.length - 1" class="h-px flex-1 bg-border-hairline" />
        </li>
      </ol>

      <div class="grid gap-8 lg:grid-cols-[1fr_340px]">
        <div class="rounded-card border border-border-hairline bg-surface-1 p-6">
          <!-- 1. Delivery -->
          <form v-if="checkout.step === 1" class="space-y-4" @submit.prevent="checkout.next()">
            <h2 class="font-semibold">Where is it going?</h2>
            <div class="grid gap-4 sm:grid-cols-2">
              <label class="block sm:col-span-2">
                <span class="mb-1.5 block text-sm text-text-secondary">Full name</span>
                <input v-model="checkout.address.name" required autocomplete="name" class="input" />
              </label>
              <label class="block sm:col-span-2">
                <span class="mb-1.5 block text-sm text-text-secondary">Email</span>
                <input v-model="checkout.address.email" type="email" required autocomplete="email" class="input" />
              </label>
              <label class="block sm:col-span-2">
                <span class="mb-1.5 block text-sm text-text-secondary">Address</span>
                <input v-model="checkout.address.line1" required autocomplete="address-line1" class="input" />
              </label>
              <label class="block">
                <span class="mb-1.5 block text-sm text-text-secondary">City</span>
                <input v-model="checkout.address.city" required autocomplete="address-level2" class="input" />
              </label>
              <div class="grid grid-cols-2 gap-4">
                <label class="block">
                  <span class="mb-1.5 block text-sm text-text-secondary">State</span>
                  <select v-model="checkout.address.state" required class="input">
                    <option value="" disabled>—</option>
                    <option v-for="code in STATES" :key="code" :value="code">{{ code }}</option>
                  </select>
                </label>
                <label class="block">
                  <span class="mb-1.5 block text-sm text-text-secondary">ZIP</span>
                  <input v-model="checkout.address.postal" required inputmode="numeric" placeholder="94016" autocomplete="postal-code" class="input" />
                </label>
              </div>
            </div>
            <button type="submit" class="btn-primary w-full" :disabled="!checkout.stepValid(1)">
              Continue to shipping
            </button>
          </form>

          <!-- 2. Shipping -->
          <form v-else-if="checkout.step === 2" class="space-y-4" @submit.prevent="checkout.next()">
            <h2 class="font-semibold">How fast?</h2>
            <div class="space-y-2">
              <label
                v-for="[id, option] in METHODS"
                :key="id"
                class="flex cursor-pointer items-center gap-3 rounded border p-3.5 transition-colors"
                :class="checkout.method === id ? 'border-accent bg-accent/5' : 'border-border-hairline hover:border-border-strong'"
              >
                <input v-model="checkout.method" type="radio" :value="id" class="accent-accent" />
                <span class="flex-1">
                  <span class="block text-sm font-medium">{{ option.label }}</span>
                  <span class="block text-xs text-text-secondary">{{ option.transit }}</span>
                </span>
                <span class="nums text-sm">
                  <template v-if="option.freeAbove !== undefined && cart.subtotalCents >= option.freeAbove">
                    <span class="text-accent-green">Free</span>
                  </template>
                  <template v-else>{{ format(option.cents) }}</template>
                </span>
              </label>
            </div>
            <div class="flex gap-3">
              <button type="button" class="btn-ghost flex-1" @click="checkout.goTo(1)">Back</button>
              <button type="submit" class="btn-primary flex-1">Continue to payment</button>
            </div>
          </form>

          <!-- 3. Payment -->
          <form v-else class="space-y-4" @submit.prevent="place">
            <h2 class="flex items-center gap-2 font-semibold">
              <Lock class="h-3.5 w-3.5 text-accent-green" aria-hidden="true" />
              Payment
            </h2>

            <!-- Said plainly, because a card field that looks real deserves to
                 be labelled when it is not. -->
            <div class="rounded border border-border-hairline bg-surface-2/60 p-3 text-xs text-text-secondary">
              <p class="font-medium text-text-primary">This is a demo. No card is charged.</p>
              <p class="mt-1">
                Use <button type="button" class="code text-accent underline" @click="checkout.card.number = '4242 4242 4242 4242'">4242 4242 4242 4242</button> to succeed,
                or <button type="button" class="code text-accent underline" @click="checkout.card.number = '4000 0000 0000 0002'">4000 0000 0000 0002</button> to see a decline.
              </p>
            </div>

            <label class="block">
              <span class="mb-1.5 block text-sm text-text-secondary">Card number</span>
              <div class="relative">
                <CreditCard class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" aria-hidden="true" />
                <input v-model="checkout.card.number" inputmode="numeric" placeholder="4242 4242 4242 4242" class="input pl-9" />
              </div>
            </label>
            <div class="grid grid-cols-2 gap-4">
              <label class="block">
                <span class="mb-1.5 block text-sm text-text-secondary">Expiry</span>
                <input v-model="checkout.card.expiry" placeholder="12/29" class="input" />
              </label>
              <label class="block">
                <span class="mb-1.5 block text-sm text-text-secondary">CVC</span>
                <input v-model="checkout.card.cvc" placeholder="123" class="input" />
              </label>
            </div>

            <p
              v-if="checkout.error"
              class="flex items-start gap-2 rounded border border-accent-red/30 bg-accent-red/5 p-3 text-sm text-accent-red"
              role="alert"
            >
              <AlertCircle class="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {{ checkout.error }}
            </p>

            <div class="flex gap-3">
              <button type="button" class="btn-ghost flex-1" @click="checkout.goTo(2)">Back</button>
              <button type="submit" class="btn-primary flex-1" :disabled="!canPlace || checkout.placing">
                {{ checkout.placing ? 'Processing…' : `Pay ${format(checkout.totals.total)}` }}
              </button>
            </div>
          </form>
        </div>

        <div class="lg:sticky lg:top-24 lg:self-start">
          <OrderSummary
            :lines="cart.items"
            :totals="checkout.totals"
            :method="checkout.method"
            :state="checkout.address.state"
          />
        </div>
      </div>
    </div>
  </div>
</template>
