<script setup lang="ts">
/**
 * The three-step wizard.
 *
 * A step cannot be reached until the ones before it validate — `highestReachable`
 * is enforced here rather than by hiding buttons, so a bookmarked `?step=3`
 * lands on the first incomplete step instead of a payment form with no address
 * behind it.
 */
import { computed, onMounted, ref, type Component } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { Check, Lock, AlertCircle, CreditCard, Landmark, Wallet } from 'lucide-vue-next'
import { CHANNELS, METHOD_LABEL, cardBrand, cardProblem, type PayMethod, type SimOutcome } from '@/lib/payment'
import PaymentSimulator from '@/components/checkout/PaymentSimulator.vue'
import { useCartStore } from '@/stores/cart'
import { useAuthStore } from '@/stores/auth'
import { useCheckoutStore } from '@/stores/checkout'
import { useCurrency } from '@/composables/useCurrency'
import { methodsFor } from '@/lib/shipping'
import { COUNTRIES, findCountry } from '@/lib/regions'
import OrderSummary from '@/components/checkout/OrderSummary.vue'

const cart = useCartStore()
const auth = useAuthStore()
const checkout = useCheckoutStore()
const router = useRouter()
const { format } = useCurrency()

const STEPS = [
  { n: 1 as const, label: 'Delivery' },
  { n: 2 as const, label: 'Shipping' },
  { n: 3 as const, label: 'Payment' },
]

/**
 * Only what a carrier actually runs to this address. Overnight exists in the
 * United States and nowhere else, so it disappears rather than being offered
 * and then refused by the order endpoint.
 */
const methods = computed(() => methodsFor(checkout.address.country))

/**
 * The destination's own rules: what its subdivisions are called and are, and
 * what a postcode looks like there. Everything below the country select reads
 * off this rather than assuming an American address.
 */
const country = computed(() => findCountry(checkout.address.country))

const canPlace = computed(
  () => checkout.stepValid(3) && cart.items.length > 0 && !cart.hasUnavailable,
)

onMounted(() => {
  if (!cart.items.length) router.replace('/cart')

  /*
   * Fill what the account already knows, and only what is still blank. A
   * returning shopper should not retype their own name — but overwriting a
   * half-typed field because a session resolved a moment later would be worse
   * than not helping at all.
   */
  if (auth.signedIn && auth.user) {
    if (!checkout.address.name.trim()) checkout.address.name = auth.user.name
    if (!checkout.address.email.trim()) checkout.address.email = auth.user.email
  }
})

const PAY_OPTIONS: { id: PayMethod; icon: Component }[] = [
  { id: 'card', icon: CreditCard },
  { id: 'fpx', icon: Landmark },
  { id: 'ewallet', icon: Wallet },
]

const brand = computed(() => cardBrand(checkout.card.number))
/** Said once every field has something in it; nagging mid-typing helps nobody. */
const cardHint = computed(() => {
  const c = checkout.card
  return c.number.trim() && c.expiry.trim() && c.cvc.trim() ? (cardProblem(c) ?? '') : ''
})

function fillTestCard(number: string) {
  checkout.card.number = number
  // Any future month works; filled in so the published numbers are one click.
  if (!checkout.card.expiry) checkout.card.expiry = '12/30'
  if (!checkout.card.cvc) checkout.card.cvc = '123'
}

/** FPX and e-wallets go through the simulator screen first; a card is decided here. */
const simulating = ref(false)

async function pay() {
  if (checkout.payMethod === 'card') return finish(await checkout.place())
  simulating.value = true
}

async function simulated(outcome: SimOutcome) {
  simulating.value = false
  finish(await checkout.place(outcome))
}

function finish(result: { ok: boolean; id?: string }) {
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

            <!--
              Offered, never required. Guest checkout is the shorter path and
              stays the default; the only thing signing in changes is whether
              this order can be found again from another device.
            -->
            <p
              v-if="!auth.signedIn"
              class="rounded border border-border-hairline bg-surface-2/60 p-3 text-xs text-text-secondary"
            >
              <RouterLink to="/account?next=/checkout" class="text-accent underline">Sign in</RouterLink>
              to keep this order with your account, or carry on as a guest — checkout works either
              way.
            </p>

            <div class="grid gap-4 sm:grid-cols-2">
              <!--
                Country first, because everything under it depends on the
                answer: which subdivisions exist, what the postcode field is
                called and checks for, and which tax the summary quotes.
              -->
              <label class="block sm:col-span-2">
                <span class="mb-1.5 block text-sm text-text-secondary">Country or region</span>
                <select
                  :value="checkout.address.country"
                  required
                  autocomplete="country"
                  class="input"
                  @change="checkout.setCountry(($event.target as HTMLSelectElement).value)"
                >
                  <option v-for="c in COUNTRIES" :key="c.code" :value="c.code">{{ c.name }}</option>
                </select>
              </label>

              <label class="block sm:col-span-2">
                <span class="mb-1.5 block text-sm text-text-secondary">Full name</span>
                <input v-model="checkout.address.name" required autocomplete="name" class="input" />
              </label>
              <label class="block">
                <span class="mb-1.5 block text-sm text-text-secondary">Email</span>
                <input v-model="checkout.address.email" type="email" required autocomplete="email" class="input" />
              </label>
              <label class="block">
                <span class="mb-1.5 block text-sm text-text-secondary">
                  Phone <span class="text-text-muted">(optional)</span>
                </span>
                <input v-model="checkout.address.phone" type="tel" autocomplete="tel" placeholder="+1 555 010 0199" class="input" />
              </label>

              <label class="block sm:col-span-2">
                <span class="mb-1.5 block text-sm text-text-secondary">Street address</span>
                <input v-model="checkout.address.line1" required autocomplete="address-line1" class="input" />
              </label>
              <label class="block sm:col-span-2">
                <span class="mb-1.5 block text-sm text-text-secondary">
                  Apartment, suite, floor <span class="text-text-muted">(optional)</span>
                </span>
                <input v-model="checkout.address.line2" autocomplete="address-line2" class="input" />
              </label>

              <label class="block">
                <span class="mb-1.5 block text-sm text-text-secondary">City</span>
                <input v-model="checkout.address.city" required autocomplete="address-level2" class="input" />
              </label>
              <!-- Absent, not blank, where a country has no subdivisions: an
                   empty "State" on a Singapore address is a field that can only
                   be got wrong. -->
              <label v-if="country?.subdivisions" class="block">
                <span class="mb-1.5 block text-sm text-text-secondary">
                  {{ country.subdivisionLabel }}
                </span>
                <select v-model="checkout.address.state" required autocomplete="address-level1" class="input">
                  <option value="" disabled>Select…</option>
                  <option v-for="s in country.subdivisions" :key="s.code" :value="s.code">
                    {{ s.name }}
                  </option>
                </select>
              </label>
              <label class="block">
                <span class="mb-1.5 block text-sm text-text-secondary">
                  {{ country?.postalLabel ?? 'Postal code' }}
                </span>
                <input
                  v-model="checkout.address.postal"
                  required
                  :placeholder="country?.postalExample"
                  autocomplete="postal-code"
                  class="input"
                />
              </label>
            </div>
            <button type="submit" class="btn-primary w-full" :disabled="!checkout.stepValid(1)">
              Continue to shipping
            </button>
          </form>

          <!-- 2. Shipping -->
          <form v-else-if="checkout.step === 2" class="space-y-4" @submit.prevent="checkout.next()">
            <h2 class="font-semibold">How fast?</h2>
            <p class="text-xs text-text-secondary">
              To {{ country?.name }}. Rates and transit times are for this destination.
            </p>
            <div class="space-y-2">
              <label
                v-for="option in methods"
                :key="option.id"
                class="flex cursor-pointer items-center gap-3 rounded border p-3.5 transition-colors"
                :class="checkout.method === option.id ? 'border-accent bg-accent/5' : 'border-border-hairline hover:border-border-strong'"
              >
                <input v-model="checkout.method" type="radio" :value="option.id" class="accent-accent" />
                <span class="flex-1">
                  <span class="block text-sm font-medium">{{ option.label }}</span>
                  <span class="block text-xs text-text-secondary">{{ option.rate.transit }}</span>
                </span>
                <span class="nums text-sm">
                  <template v-if="option.rate.freeAbove !== undefined && cart.subtotalCents >= option.rate.freeAbove">
                    <span class="text-accent-green">Free</span>
                  </template>
                  <template v-else>{{ format(option.rate.cents) }}</template>
                </span>
              </label>
            </div>
            <div class="flex gap-3">
              <button type="button" class="btn-ghost flex-1" @click="checkout.goTo(1)">Back</button>
              <button type="submit" class="btn-primary flex-1">Continue to payment</button>
            </div>
          </form>

          <!-- 3. Payment -->
          <form v-else class="space-y-4" @submit.prevent="pay">
            <h2 class="flex items-center gap-2 font-semibold">
              <Lock class="h-3.5 w-3.5 text-accent-green" aria-hidden="true" />
              Payment
            </h2>

            <!-- Said plainly, because a payment form that looks real deserves
                 to be labelled when it is not. -->
            <div class="rounded border border-border-hairline bg-surface-2/60 p-3 text-xs text-text-secondary">
              <p class="font-medium text-text-primary">This is a demo. Nothing is charged and no bank is contacted.</p>
              <p v-if="checkout.payMethod === 'card'" class="mt-1">
                Use <button type="button" class="code text-accent underline" @click="fillTestCard('4242 4242 4242 4242')">4242 4242 4242 4242</button> to succeed,
                or <button type="button" class="code text-accent underline" @click="fillTestCard('4000 0000 0000 0002')">4000 0000 0000 0002</button> to see a decline.
              </p>
              <p v-else class="mt-1">The next screen lets you choose what the {{ checkout.payMethod === 'fpx' ? 'bank' : 'wallet' }} would answer.</p>
            </div>

            <!-- Methods and banks as plain names with generic icons: no logos. -->
            <fieldset>
              <legend class="mb-1.5 block text-sm text-text-secondary">Pay with</legend>
              <div class="grid gap-2 sm:grid-cols-3">
                <label
                  v-for="option in PAY_OPTIONS"
                  :key="option.id"
                  class="flex cursor-pointer items-center gap-2 rounded border p-3 text-sm transition-colors"
                  :class="checkout.payMethod === option.id ? 'border-accent bg-accent/5' : 'border-border-hairline hover:border-border-strong'"
                >
                  <input
                    type="radio"
                    name="pay-method"
                    :value="option.id"
                    :checked="checkout.payMethod === option.id"
                    class="accent-accent"
                    @change="checkout.setPayMethod(option.id)"
                  />
                  <component :is="option.icon" class="h-4 w-4 text-text-secondary" aria-hidden="true" />
                  {{ METHOD_LABEL[option.id] }}
                </label>
              </div>
            </fieldset>

            <template v-if="checkout.payMethod === 'card'">
              <label class="block">
                <span class="mb-1.5 flex justify-between text-sm text-text-secondary">
                  Card number
                  <span v-if="brand" class="text-text-primary">{{ brand }}</span>
                </span>
                <div class="relative">
                  <CreditCard class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" aria-hidden="true" />
                  <input v-model="checkout.card.number" inputmode="numeric" autocomplete="cc-number" placeholder="4242 4242 4242 4242" class="input pl-9" />
                </div>
              </label>
              <div class="grid grid-cols-2 gap-4">
                <label class="block">
                  <span class="mb-1.5 block text-sm text-text-secondary">Expiry (MM/YY)</span>
                  <input v-model="checkout.card.expiry" autocomplete="cc-exp" placeholder="12/29" class="input" />
                </label>
                <label class="block">
                  <span class="mb-1.5 block text-sm text-text-secondary">CVC</span>
                  <input v-model="checkout.card.cvc" inputmode="numeric" autocomplete="cc-csc" :placeholder="brand === 'Amex' ? '1234' : '123'" class="input" />
                </label>
              </div>
              <p v-if="cardHint" class="text-xs text-accent-amber">{{ cardHint }}</p>
            </template>

            <label v-else class="block">
              <span class="mb-1.5 block text-sm text-text-secondary">
                {{ checkout.payMethod === 'fpx' ? 'Your bank' : 'Your e-wallet' }}
              </span>
              <select v-model="checkout.channel" required class="input">
                <option value="" disabled>Select…</option>
                <option v-for="name in CHANNELS[checkout.payMethod]" :key="name" :value="name">{{ name }}</option>
              </select>
            </label>

            <p
              v-if="checkout.error || cart.hasUnavailable"
              class="flex items-start gap-2 rounded border border-accent-red/30 bg-accent-red/5 p-3 text-sm text-accent-red"
              role="alert"
            >
              <AlertCircle class="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {{ checkout.error || 'Some items are no longer available. Remove them from your cart to continue.' }}
            </p>

            <div class="flex gap-3">
              <button type="button" class="btn-ghost flex-1" @click="checkout.goTo(2)">Back</button>
              <button type="submit" class="btn-primary flex-1" :disabled="!canPlace || checkout.placing">
                {{ checkout.placing ? 'Processing…' : `Pay ${format(checkout.totals.total)}` }}
              </button>
            </div>
          </form>
        </div>

        <PaymentSimulator
          v-if="simulating && checkout.payMethod !== 'card'"
          :method="checkout.payMethod"
          :channel="checkout.channel"
          :amount="format(checkout.totals.total)"
          @done="simulated"
        />

        <div class="lg:sticky lg:top-24 lg:self-start">
          <OrderSummary
            :lines="cart.lines"
            :totals="checkout.totals"
            :method="checkout.method"
            :country="checkout.address.country"
            :state="checkout.address.state"
          />
        </div>
      </div>
    </div>
  </div>
</template>
