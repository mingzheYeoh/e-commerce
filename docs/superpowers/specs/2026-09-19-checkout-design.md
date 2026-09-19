# NEXUS Checkout — Design

**Date:** 2026-09-19
**Status:** Approved (user delegated all open decisions: "全部你来决定")

## Goal

Close the only dead end in the storefront. `CartDrawer.vue:162` renders a
`disabled` Checkout button while `SiteFooter.vue:38` advertises "Encrypted
checkout, PCI-DSS compliant". Ship a real three-step checkout that ends at a
persistent order confirmation.

## Scope

| Route | Page | Purpose |
|---|---|---|
| `/cart` | `CartPage.vue` | Full cart view; the drawer stays for quick edits |
| `/checkout` | `CheckoutPage.vue` | Three-step wizard, owns step state |
| `/order/:id` | `OrderPage.vue` | Persistent confirmation, reloadable |

Out of scope: accounts, saved addresses, real inventory re-check, coupons.

## Payment: simulated, no dependency

No Stripe SDK. A real Stripe integration cannot complete a payment here — a
PaymentIntent must be created server-side with the secret key, and this project
has no backend. The publishable key would have been safe to ship (it is designed
to be public), but it only buys card tokenisation, not a charge.

`src/lib/payment.ts` recognises Stripe's **publicly documented test card
numbers** and maps them to outcomes:

| Card number | Outcome code | Message |
|---|---|---|
| `4242424242424242` | `succeeded` | — |
| `4000000000000002` | `card_declined` | Your card was declined. |
| `4000000000009995` | `insufficient_funds` | Your card has insufficient funds. |
| `4000000000000069` | `expired_card` | Your card has expired. |
| anything else | `invalid_number` | That card number is not valid. |

Any number not in the table is Luhn-checked first, so typos report
`invalid_number` rather than silently "succeeding".

Simulating rather than integrating is the stronger choice here: failure paths
become demonstrable. A checkout that only has a happy path proves less.

## Money rules

All arithmetic in integer cents. The cart already freezes `unitPriceCents` at
add time; checkout reads that and never re-derives price from `products.ts`.

**Shipping** (`shippingCents(method, subtotalCents)`):

| Method | Transit | Price |
|---|---|---|
| `standard` | 3–5 business days | Free over $75.00, otherwise $8.95 |
| `express` | 2 business days | $14.95 |
| `overnight` | Next business day | $29.95 |

Modelled on mainstream US electronics retail (Best Buy free over $35, B&H free
over $49); the threshold is set at $75 because this catalogue's median line is
higher.

**Tax** (`taxCents(subtotalCents, state)`): destination-based, from a state
table. Shipping is not taxed.

| State | Rate | | State | Rate |
|---|---|---|---|---|
| CA | 7.25% | | MA | 6.25% |
| NY | 8.875% | | GA | 4.00% |
| TX | 6.25% | | AZ | 5.60% |
| WA | 6.50% | | PA | 6.00% |
| FL | 6.00% | | IL | 6.25% |
| **OR, DE, MT, NH, AK** | **0%** | | any other | 6.00% |

The five no-sales-tax states are included deliberately: they give a visible
`$0.00` tax case, which proves tax is a function of destination rather than a
hardcoded multiplier.

Rounding: `Math.round(subtotalCents * rate)` — one rounding step, on cents.
Never `subtotal * 0.08` in dollars: `2699.00 * 0.08 = 215.92000000000002`.

## Files

```
src/pages/CartPage.vue                  /cart
src/pages/CheckoutPage.vue              /checkout, owns step + placement
src/pages/OrderPage.vue                 /order/:id
src/components/checkout/CheckoutSteps.vue   progress rail
src/components/checkout/ShippingForm.vue    step 1
src/components/checkout/DeliveryForm.vue    step 2
src/components/checkout/PaymentForm.vue     step 3
src/components/checkout/OrderSummary.vue    sticky rail, shared with OrderPage
src/stores/checkout.ts                  address, method, card, step, validity
src/stores/orders.ts                    placed orders, localStorage-backed
src/lib/money.ts                        shippingCents, taxCents, totalCents
src/lib/payment.ts                      luhn, charge
```

Field validators (required / email / 5-digit ZIP) are three one-line functions
inside `checkout.ts`. They do not justify a module.

## Data flow

```
cart.items (frozen cents)
   -> cart.subtotalCents
checkout store (address.state, method)
   -> money.shippingCents + money.taxCents
   -> OrderSummary (display only)
   -> place():
        payment.charge(card)
          ok    -> orders.record() -> cart.$reset() -> push /order/:id
          fail  -> stay on step 3, surface message, cart untouched
```

`place()` clears the cart **only after** a successful charge. Reversing that
order means one declined card empties the customer's bag.

## Persistence

Both stores mirror to `localStorage` through `$subscribe`:

- `nexus:cart` — the cart currently evaporates on reload. Merely annoying while
  browsing; fatal at checkout step 3.
- `nexus:orders` — `/order/:id` is a URL people reload and bookmark, so the
  order must outlive the tab.

Reads are wrapped in try/catch: private windows and blocked site data can throw
on access, and a storefront must still render.

## Guards

- `/checkout` with an empty cart redirects to `/cart`.
- Steps 2 and 3 are unreachable until earlier steps validate; a direct
  `?step=3` falls back to the first invalid step.
- `/order/:id` with an unknown id renders `NotFoundPage`.

## Testing

| File | Covers |
|---|---|
| `src/lib/money.spec.ts` | free-shipping threshold boundary ($74.99 / $75.00), each method, zero-tax states, rounding with no float drift |
| `src/lib/payment.spec.ts` | every test card maps to its outcome, Luhn rejects a typo, spaces and dashes are tolerated |
| `src/stores/checkout.spec.ts` | cannot advance past an invalid step; a declined charge leaves the cart intact; a successful charge empties it |

The declined-charge assertion is the important one — it is the state machine
constraint most likely to be written backwards.
