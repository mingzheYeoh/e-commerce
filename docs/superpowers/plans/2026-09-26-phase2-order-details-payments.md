# Phase 2 — order details and Malaysian payments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement "Phase 2 — order details and Malaysian payments" of
`docs/superpowers/specs/2026-09-26-nexusohm-launch-design.md`: a detailed order
page and expandable account order rows, and simulated card / FPX / e-wallet
payments recorded on the order as method, channel and a server-minted ref.

**Architecture:** One shared module, `src/lib/payment.ts`, owns the payment
allow-lists, card validation and the simulator outcomes; the storefront uses it
to authorise and the worker imports it (as it already imports `money.ts`) to
validate what it is sent. The worker stores three new `orders` columns
(migration `0015`) and returns them; `getOrder` gains per-line product id,
seller and (owner only) fulfilment status. The storefront renders lines through
one new component shared by the order page and the account page. The console
payments ledger gains two fields on charges.

**Tech Stack:** Vue 3 + Pinia + vue-router, Tailwind, lucide-vue-next, Vitest
(jsdom by default, `node:sqlite` via `worker/test/d1-memory.ts`), Cloudflare
Workers + D1.

## Global Constraints

- Money is integer minor units; never add currencies together.
- All payments simulated. Card number / expiry / CVC never leave the browser;
  the server receives only `paymentMethod` and `paymentChannel`.
- `paymentChannel` validated server-side against the allow-list; `payment_ref`
  minted by the server, shape `SIM-<CARD|FPX|EWALLET>-XXXXXX`.
- No bank or wallet logos, no imitation bank login pages: names as plain text,
  generic lucide icons. Simulator screen title verbatim:
  "NEXUSOHM payment simulator — no real bank is contacted".
- Declined, timed-out and cancelled attempts place no order (no POST), and keep
  the cart, exactly as a declined card does today.
- Test cards keep their outcomes: `4242 4242 4242 4242` succeeds,
  `4000 0000 0000 0002` declines (and the other two in `TEST_CARDS`).
- Non-owners of an order keep getting redacted address data; delivery status
  and the payment ref are owner-only, like `parts`.
- Every new tenancy repository method needs an isolation-sweep `CASES` entry.
  This plan adds none (it widens `payments.list`'s rows only).
- Brand strings in touched files stay as they are (another branch renames).
- No remote migration, no deploy.

## File map

| File | Change |
|---|---|
| `src/lib/payment.ts` (+spec) | allow-lists, `cardBrand`, `cardProblem`, `chargeCard`, `settle` |
| `worker/migrations/0015-payment-method.sql` | three `ALTER TABLE orders ADD COLUMN` |
| `worker/schema.sql` | the `0015` block appended verbatim |
| `worker/src/tenancy.spec.ts` | identity test for `0015` |
| `worker/src/orders.ts` (+spec) | validate/store/mint payment; richer `getOrder` |
| `worker/src/tenancy.ts`, `worker/src/console.ts` (+spec) | method/channel on ledger charges |
| `console/src/api.ts`, `console/src/pages/Payments.vue` | show + export them |
| `src/lib/api.ts` | wire types |
| `src/stores/checkout.ts` (+spec) | pay method state, `place(outcome?)`, remote merge |
| `src/components/checkout/PaymentSimulator.vue` | FPX / e-wallet simulator overlay |
| `src/components/checkout/OrderLines.vue` (+spec) | detailed line list |
| `src/components/checkout/OrderSummary.vue` | `hideLines` prop |
| `src/pages/CheckoutPage.vue` | method picker, card brand, simulator |
| `src/pages/OrderPage.vue` (+spec) | details, payment line, single fetch |
| `src/pages/AccountPage.vue` | expandable rows |
| `worker/migrations/README.md` | Pending: `0015` |

---

### Task 1: Shared payment rules

**Files:** Modify `src/lib/payment.ts`, test `src/lib/payment.spec.ts`.

**Produces:**
```ts
export type PayMethod = 'card' | 'fpx' | 'ewallet'
export const CARD_BRANDS: readonly ['Visa', 'Mastercard', 'Amex']
export const FPX_BANKS: readonly [/* 12 names from the spec */]
export const EWALLETS: readonly ["Touch 'n Go eWallet", 'GrabPay', 'Boost', 'ShopeePay']
export const CHANNELS: Record<PayMethod, readonly string[]>
export function cardBrand(number: string): CardBrand | null      // by prefix
export function cardProblem(card: { number: string; expiry: string; cvc: string }, now?: Date): string | null
export function chargeCard(card, now?: Date): ChargeResult & { brand?: CardBrand }
export type SimOutcome = 'approved' | 'declined' | 'timeout' | 'cancelled'
export function settle(outcome: SimOutcome): ChargeResult
```
`cardProblem` order: Luhn → brand supported → length for brand (Visa 13/16/19,
Mastercard 16, Amex 15) → expiry `MM/YY` not before the current month → CVC
3 digits (Amex 4). `chargeCard` returns `invalid_number` for a Luhn failure
(unchanged message), a failure with the problem as message for any other
problem, else `charge(number)` plus `brand`.

- [ ] Step 1: tests — brand by prefix (4…, 51–55 and 2221–2720, 34/37, 6011 → null);
  Luhn-valid Discover refused as unsupported; expiry last month refused, this
  month accepted; Amex needs 4-digit CVC; both published test cards keep their
  outcomes through `chargeCard` with a valid expiry/CVC; `settle` maps
  `approved` → ok, the other three → distinct not-ok codes with messages.
  Every name in `CHANNELS` is plain text (no URL, no `<`).
- [ ] Step 2: run `npx vitest run src/lib/payment.spec.ts` — FAIL (not exported).
- [ ] Step 3: implement.
- [ ] Step 4: run — PASS. Commit `feat(payment): shared card, FPX and e-wallet rules`.

### Task 2: Migration 0015 and the order endpoint

**Files:** Create `worker/migrations/0015-payment-method.sql`; modify
`worker/schema.sql`, `worker/src/tenancy.spec.ts`, `worker/src/orders.ts`,
`worker/src/orders.spec.ts`, `worker/migrations/README.md`.

Migration:
```sql
ALTER TABLE orders ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'card'
  CHECK (payment_method IN ('card','fpx','ewallet'));
ALTER TABLE orders ADD COLUMN payment_channel TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN payment_ref TEXT NOT NULL DEFAULT '';
```
Appended to `schema.sql` under a `-- ---- 0015` header like `0014`; an identity
test like the `0014` one.

`placeOrder`:
- `paymentMethod` absent → `card` with channel `''` (a storefront cached from
  before this deploy sends neither; refusing it would break checkout between
  the API and storefront deploys). Present → must be a `PayMethod`, and
  `paymentChannel` must be in `CHANNELS[method]`, else 400 `bad payment method`
  / `bad payment channel`.
- `fpx` / `ewallet` with a `paymentCode` other than `succeeded` → 400.
- Ref: `SIM-${CARD|FPX|EWALLET}-` + 6 chars from the order-id alphabet via
  `crypto.getRandomValues`.
- Insert the three columns; 200 body gains `payment: { method, channel, ref }`;
  the already-stored branch returns the stored three.

`getOrder`:
- `payment: { method, channel, ref }` with `ref` null for non-owners.
- Lines gain `productId`, `seller` (merchant name) and `status` (that seller's
  part status, owner only, else null), from one join over `order_lines`,
  `merchants`, `order_fulfilments`.

- [ ] Step 1: tests in `orders.spec.ts`: FPX order stores method/channel and a
  `SIM-FPX-[A-HJ-NP-Z2-9]{6}` ref and returns it; unknown bank → 400 and
  nothing stored; card + unknown brand → 400; missing method → stored as card;
  fpx with `card_declined` → 400; retry returns the stored ref; `getOrder`
  for owner has productId/seller/status/ref, for a stranger status null, ref
  null, street still blank. Identity test for 0015 in `tenancy.spec.ts`.
- [ ] Step 2: run `npx vitest run worker/src/orders.spec.ts worker/src/tenancy.spec.ts` — FAIL.
- [ ] Step 3: implement, README "Pending" section names `0015`.
- [ ] Step 4: PASS. Commit `feat(orders): record simulated payment method, channel and ref (0015)`.

### Task 3: Console ledger shows method and channel

**Files:** `worker/src/tenancy.ts` (`PaymentEntry`, both charge branches select
`o.payment_method`, `o.payment_channel`; refund/payout branches `NULL`),
`worker/src/console.ts` (`paymentsOut` emits `paymentMethod`, `paymentChannel`),
`worker/src/console.spec.ts`, `console/src/api.ts`, `console/src/pages/Payments.vue`
(under the order ref: "FPX · Maybank2u"; CSV gains two columns).

- [ ] Step 1: extend the payments ledger test: charges carry
  `paymentMethod: 'card'` for rows stored before 0015 (the default), refunds
  and payouts carry null.
- [ ] Step 2: FAIL. Step 3: implement. Step 4: PASS (and the isolation sweep +
  completeness test unchanged — no new method). Commit.

### Task 4: Checkout store

**Files:** `src/stores/checkout.ts`, `src/stores/checkout.spec.ts`, `src/lib/api.ts`.

State: `payMethod: PayMethod` (default `'card'`), `channel: string`.
`stepValid(3)`: card → `cardProblem(card) === null`; others → channel in
`CHANNELS[payMethod]`. `place(outcome?: SimOutcome)`: card → `chargeCard(card)`,
channel = brand; fpx/ewallet → `settle(outcome ?? 'cancelled')`. Failure: error
message, cart kept, no `saveOrder`. Request gains `paymentMethod`,
`paymentChannel`. `Order` gains `payment?: { method; channel; ref: string | null }`
(from the save answer) and lines may carry `seller`, `status`.
`loadOrder(id, remote?)`: local first, enriched from `remote` when given
(lines matched by `productId|finish`, payment from remote if local has none);
otherwise built from `remote ?? await fetchOrder(id)`, thumbnails looked up by
`productId` (falling back to sku). `loadParts` is removed (the page fetches once).

- [ ] Step 1: tests: `fill()` sets a valid expiry and CVC; FPX approved posts
  `paymentMethod: 'fpx', paymentChannel: 'Maybank2u'` and nothing card-shaped
  (no number/expiry/cvc in the body); FPX declined / e-wallet timeout → no
  save, cart kept, error names what happened; card posts `paymentChannel: 'Visa'`;
  receipt keeps the server's payment ref; loadOrder enriches a local order
  from a remote one.
- [ ] Step 2: FAIL. Step 3: implement. Step 4: PASS. Commit.

### Task 5: Order lines, order page, account page

**Files:** Create `src/components/checkout/OrderLines.vue` (+spec); modify
`OrderSummary.vue` (`hideLines?: boolean`), `OrderPage.vue` (+spec),
`AccountPage.vue`.

`OrderLines` props: `lines: DetailLine[]` where
`DetailLine = { productId; sku; title; finish?; thumb; unitPriceCents; qty; seller?; status? }`.
Per line: thumbnail, title as `RouterLink` to `/product/<id>` when
`findProduct(id)` exists, else plain text + "no longer available"; finish, SKU,
`format(unit)` × qty, `format(unit*qty)`, seller, status badge.

Order page: one `fetchOrder(id)`, `order = loadOrder(id, remote)`,
`parts = remote?.parts ?? null`; an "Items" section with `OrderLines`; the
summary with `hide-lines`; a payment line ("Paid by FPX online banking ·
Maybank2u · ref SIM-FPX-…").

Account page: each row gets a toggle button (`aria-expanded`) that on first
open calls `fetchOrder(id)`, caches it, and renders `OrderLines` beneath the
row with subtotal/shipping/tax/total.

- [ ] Step 1: tests: OrderLines links a live product and marks a missing one
  "no longer available"; shows SKU, unit price, line total, seller, status.
  Order page shows the payment method/channel and the lines' details.
- [ ] Step 2: FAIL. Step 3: implement. Step 4: PASS. Commit.

### Task 6: Checkout page UI and simulator

**Files:** Create `src/components/checkout/PaymentSimulator.vue`; modify
`src/pages/CheckoutPage.vue`.

Method radio group (CreditCard / Landmark / Wallet icons, plain text). Card:
detected brand as text, inline `cardProblem` message once all three fields are
filled. FPX: bank `<select>`. E-wallet: wallet `<select>`. Pay on fpx/ewallet
opens `PaymentSimulator` (role="dialog", title verbatim): FPX → Approve /
Decline / Time out; e-wallet → decorative SVG QR generated locally from a
seeded PRNG, 3:00 countdown, Simulate paid / Cancel, timeout on zero. Its
`done(outcome)` calls `checkout.place(outcome)`.

- [ ] Step 1: simulator spec: title text; e-wallet countdown reaching zero
  emits `timeout` (fake timers); FPX buttons emit their outcomes.
- [ ] Step 2: FAIL. Step 3: implement. Step 4: PASS. Commit.

### Task 7: Gates and push

- [ ] `npx vitest run` (root) and `cd worker && npx vitest run` green.
- [ ] `npx vue-tsc --noEmit -p tsconfig.app.json`, `cd worker && npx tsc --noEmit` clean.
- [ ] `npm run build`, `npm run build:console` succeed; revert a CRLF-only diff
  in `src/data/products.ts`.
- [ ] `git push -u origin feat/order-details-payments`.
