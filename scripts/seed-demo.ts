/**
 * Sample activity for the demo storefront: customers, seven months of their
 * orders, deliveries, cancellations, returns and refunds, reviews, and
 * questions answered by the sellers.
 *
 * Coherent because it is produced by the rules rather than written beside
 * them. Orders go through the real placeOrder (so totals, tax, shipping and
 * commission are what checkout charges), parts are shipped, delivered and
 * cancelled through the merchant repository, returns are opened and decided
 * through the same functions the storefront and the console call, and a review
 * is only ever written for something its author had delivered. All of it runs
 * against an in-memory copy of the target database's merchants and products;
 * only then are the timestamps spread back over the months it pretends to
 * cover, and the rows written out as a SQL file to read before applying.
 *
 *   npx vite-node scripts/seed-demo.ts -- --env staging      (or production)
 *   read worker/seeds/demo-staging.sql, then:
 *   cd worker
 *   npx wrangler d1 execute nexus-orders-staging --remote --file=seeds/demo-staging.sql
 *
 * Every customer's id starts usr_demo_ and everything else hangs off those
 * customers, which is how seeds/demo-remove.sql finds it all again. None of it
 * touches stock, the audit log or payouts: products are not written out, and
 * the other two are append-only ledgers a removal could not undo. The acting
 * staff ids (stf_demo_<merchant>) have no staff row, so nobody can sign in as
 * them, and the customers' password hashes match no password.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { memoryD1, type MemoryD1 } from '../worker/test/d1-memory'
import { placeOrder } from '../worker/src/orders'
import { scopedTo, platformWide, type Repository } from '../worker/src/tenancy'
import { saveReview, askQuestion, openReturn } from '../worker/src/uploads'
import { toB64, PBKDF2_ITERATIONS, KDF_ROUNDS } from '../worker/src/credentials'
import { methodsFor, type ShipMethod } from '../src/lib/shipping'
import { FPX_BANKS, EWALLETS, type PayMethod } from '../src/lib/payment'
import * as T from './seed-demo-text'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argAfter = (flag: string) => {
  const i = process.argv.indexOf(flag)
  return i > 0 ? process.argv[i + 1] : undefined
}
const TARGET = argAfter('--env') ?? 'staging'
const DB = { staging: 'nexus-orders-staging', production: 'nexus-orders' }[TARGET]
if (!DB) throw new Error(`--env is staging or production, not ${TARGET}`)
const OUT = path.join(ROOT, 'worker/seeds', `demo-${TARGET}.sql`)

/* ------------------------------------------------------------ randomness */

// Seeded, so the same target and day give the same data. (Ids minted inside
// the worker code, and order payment references, stay random.)
let seed = 20260930
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!
const between = (a: number, b: number) => a + rand() * (b - a)
const chance = (p: number) => rand() < p
function weighted<T>(pairs: readonly (readonly [T, number])[]): T {
  let r = rand() * pairs.reduce((s, [, w]) => s + w, 0)
  for (const [v, w] of pairs) if ((r -= w) <= 0) return v
  return pairs[pairs.length - 1]![0]
}
function poisson(mean: number): number {
  const limit = Math.exp(-mean)
  let k = 0
  for (let p = rand(); p > limit; p *= rand()) k++
  return k
}
const digits = (n: number) => Array.from({ length: n }, () => Math.floor(rand() * 10)).join('')
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const code = (n: number) => Array.from({ length: n }, () => pick([...ALPHABET])).join('')

/* ------------------------------------------------------------------ time */

const DAY = 86_400_000
const NOW = Date.now()
const SPAN_DAYS = 210
/** SQLite's datetime('now') format, which every timestamp column holds. */
const at = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')

/* ------------------------------------------------------ the target's data */

function remote<R>(sql: string): R[] {
  const wrangler = path.join(ROOT, 'worker/node_modules/wrangler/bin/wrangler.js')
  // execFile rather than a shell: the checkout's path has spaces in it.
  const out = execFileSync(process.execPath, [wrangler, 'd1', 'execute', DB!, '--remote', '--json', '--command', sql], {
    cwd: path.join(ROOT, 'worker'),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return (JSON.parse(out) as { results: R[] }[])[0]!.results
}

interface MerchantRow {
  id: string
  slug: string
  name: string
  settlement_currency: string
  status: string
  commission_bps: number
  created_at: string
}
interface ProductRow {
  id: string
  merchant_id: string
  sku: string
  title: string
  brand: string
  category: string
  price_minor: number
  currency: string
  status: string
  colorways: string
}

const DEMO = `substr(user_id, 1, 9) = 'usr_demo_'`
const DEMO_ORDERS = `order_id IN (SELECT id FROM orders WHERE ${DEMO})`

/** A fresh in-memory database holding the target's merchants and products, with stock to spare. */
function copyOf(merchants: MerchantRow[], products: ProductRow[]): MemoryD1 {
  const mem = memoryD1()
  const m = mem.raw.prepare(
    `INSERT INTO merchants (id, slug, name, settlement_currency, status, commission_bps, created_at) VALUES (?,?,?,?,?,?,?)`,
  )
  for (const r of merchants) m.run(r.id, r.slug, r.name, r.settlement_currency, r.status, r.commission_bps, r.created_at)
  const p = mem.raw.prepare(
    `INSERT INTO products (id, merchant_id, sku, title, brand, category, price_minor, currency, status, stock_count, colorways)
     VALUES (?,?,?,?,?,?,?,?,?,1000000,?)`,
  )
  for (const r of products) p.run(r.id, r.merchant_id, r.sku, r.title, r.brand, r.category, r.price_minor, r.currency, r.status, r.colorways)
  return mem
}

async function main() {
  console.log(`Reading ${DB}…`)
  const [{ n: already }] = remote<{ n: number }>(`SELECT COUNT(*) AS n FROM users WHERE substr(id, 1, 9) = 'usr_demo_'`)
  if (already) throw new Error(`${DB} already holds demo data. Apply seeds/demo-remove.sql first.`)
  const merchants = remote<MerchantRow>(`SELECT id, slug, name, settlement_currency, status, commission_bps, created_at FROM merchants`)
  const products = remote<ProductRow>(
    `SELECT id, merchant_id, sku, title, brand, category, price_minor, currency, status, colorways FROM products`,
  )
  const taken = new Set(remote<{ id: string }>(`SELECT id FROM orders`).map((r) => r.id))

  const mem = copyOf(merchants, products)
  const env = { ORDERS: mem.db }
  const active = new Set(merchants.filter((m) => m.status === 'active').map((m) => m.id))

  /* ------------------------------------------------------------ catalogue */

  const sellable = products
    .filter((p) => p.status === 'published' && active.has(p.merchant_id))
    .map((p) => {
      const kind = T.kindOf(p.id, p.category)
      let colours: string[] = []
      try {
        colours = (JSON.parse(p.colorways) as { name?: string }[]).map((c) => c.name).filter((n): n is string => !!n)
      } catch {
        /* a product with unreadable colourways is sold without a finish */
      }
      return {
        ...p,
        kind,
        colours,
        // Cheaper things sell more often; phones and earbuds most of all.
        weight: T.POPULARITY[kind] / Math.sqrt(p.price_minor / 100),
        // How well it tends to be reviewed: most products are liked, some less.
        quality: between(3.9, 4.8),
      }
    })
  if (!sellable.length) throw new Error('nothing is for sale')
  const byId = new Map(sellable.map((p) => [p.id, p]))
  type Product = (typeof sellable)[number]
  const anyProduct = () => weighted(sellable.map((p) => [p, p.weight] as const))

  /* ------------------------------------------------------------ customers */

  interface Customer {
    id: string
    name: string
    email: string
    country: T.Country
    place: T.Place
    line1: string
    phone: string
    signup: number
    loyalty: number
  }
  const customers: Customer[] = []
  const emails = new Set<string>()
  const names = new Set<string>()
  const insUser = mem.raw.prepare(
    `INSERT INTO users (id, email, name, password_hash, password_salt, iterations, kdf_rounds, created_at, email_verified_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  )
  while (customers.length < 160) {
    const country = weighted<T.Country>([
      ['MY', 72],
      ['SG', 14],
      ['US', 6],
      ['AU', 4],
      ['GB', 4],
    ])
    const { first, last } = T.namesFor(country, rand)
    const name = `${pick(first)} ${pick(last)}`
    if (names.has(name)) continue
    names.add(name)
    const local = name.toLowerCase().replace(/[^a-z ]/g, '').split(' ').filter(Boolean).join('.')
    // example.net: reserved (RFC 2606), so nothing is ever delivered to a real inbox.
    const email = `${local}${Math.floor(rand() * 90) + 10}@example.net`
    if (emails.has(email)) continue
    emails.add(email)
    const n = Math.floor(rand() * 9_000_000) + 1_000_000
    const c: Customer = {
      id: `usr_demo_${code(12)}`,
      name,
      email,
      country,
      place: pick(T.PLACES[country]),
      line1: T.streetLine(country, n, pick(T.streetsFor(country))),
      phone: T.phoneFor(country, n),
      signup: NOW - between(2, SPAN_DAYS + 30) * DAY,
      // A few customers buy again and again; most once or twice.
      loyalty: 0.3 + rand() ** 2 * 3,
    }
    customers.push(c)
    // A hash of random bytes: it matches no password, so the account cannot be signed into.
    insUser.run(
      c.id,
      c.email,
      c.name,
      toB64(crypto.getRandomValues(new Uint8Array(32))),
      toB64(crypto.getRandomValues(new Uint8Array(16))),
      PBKDF2_ITERATIONS,
      KDF_ROUNDS,
      at(c.signup),
      at(c.signup + between(2, 40) * 60_000),
    )
  }
  const userOf = (c: Customer) => ({ id: c.id, email: c.email, name: c.name })

  /* --------------------------------------------------------------- orders */

  interface Placed {
    id: string
    time: number
    customer: Customer
    method: ShipMethod
    payLabel: string
    lines: { product: Product; qty: number; finish?: string }[]
  }
  const placed: Placed[] = []
  const orderTimes = new Map<string, number>()
  const newId = () => {
    for (;;) {
      const id = `NX-${code(5)}`
      if (!taken.has(id)) return (taken.add(id), id)
    }
  }

  // Days run midnight to midnight in Malaysia (UTC+8), ending with today so far.
  const MYT = 8 * 3_600_000
  const today = Math.floor((NOW + MYT) / DAY) * DAY - MYT
  for (let day = 0; day <= SPAN_DAYS; day++) {
    const dayStart = today - (SPAN_DAYS - day) * DAY
    const date = new Date(dayStart + MYT)
    // Growing week on week, busier at weekends and around the 25th, when salaries land.
    const weekend = [0, 6].includes(date.getUTCDay()) ? 1.25 : 1
    const payday = date.getUTCDate() >= 25 && date.getUTCDate() <= 28 ? 1.4 : 1
    const count = poisson((0.8 + 2.6 * (day / SPAN_DAYS)) * weekend * payday)
    for (let k = 0; k < count; k++) {
      // Hours in Malaysian time, evenings busiest; stored in UTC like datetime('now').
      const hourMY = weighted([...Array(24).keys()].map((h) => [h, h < 7 ? 0.2 : h < 12 ? 1 : h < 19 ? 1.4 : 2.2] as const))
      const time = dayStart + hourMY * 3_600_000 + rand() * 3_600_000
      if (time >= NOW - 60_000) continue
      const eligible = customers.filter((c) => c.signup < time - 3_600_000)
      if (!eligible.length) continue
      const customer = weighted(eligible.map((c) => [c, c.loyalty] as const))

      const first = anyProduct()
      const lines: Placed['lines'] = [{ product: first, qty: 1 }]
      const companions = T.GOES_WITH[first.kind]
      if (companions && chance(0.25)) {
        const pool = sellable.filter((p) => companions.includes(p.kind) && p.id !== first.id)
        if (pool.length) lines.push({ product: weighted(pool.map((p) => [p, p.weight] as const)), qty: 1 })
      }
      if (chance(0.05)) {
        const extra = anyProduct()
        if (!lines.some((l) => l.product.id === extra.id)) lines.push({ product: extra, qty: 1 })
      }
      for (const l of lines) {
        if (l.product.price_minor < 20_000 && chance(0.12)) l.qty = 2
        if (l.product.colours.length) l.finish = pick(l.product.colours)
      }

      const methods = methodsFor(customer.country).map((m) => m.id)
      const method = weighted(methods.map((m) => [m, m === 'standard' ? 70 : m === 'express' ? 25 : 5] as const))

      const payMethod: PayMethod =
        customer.country === 'MY'
          ? weighted<PayMethod>([
              ['card', 45],
              ['fpx', 35],
              ['ewallet', 20],
            ])
          : customer.country === 'SG' && chance(0.15)
            ? 'ewallet'
            : 'card'
      const channel =
        payMethod === 'card'
          ? weighted([
              ['Visa', 55],
              ['Mastercard', 35],
              ['Amex', 10],
            ] as const)
          : payMethod === 'fpx'
            ? pick(FPX_BANKS)
            : customer.country === 'SG'
              ? 'GrabPay'
              : pick(EWALLETS)

      const payload = (id: string, paymentCode: string) => ({
        id,
        address: {
          name: customer.name,
          email: customer.email,
          phone: customer.phone,
          country: customer.country,
          line1: customer.line1,
          city: customer.place.city,
          state: customer.place.state,
          postal: customer.place.postal,
        },
        method,
        lines: lines.map((l) => ({ productId: l.product.id, qty: l.qty, finish: l.finish })),
        paymentCode,
        paymentMethod: payMethod,
        paymentChannel: channel,
        currency: T.DISPLAY_CURRENCY[customer.country],
      })

      // Now and then a card is declined first, and the shopper tries again minutes later.
      let when = time
      if (payMethod === 'card' && chance(0.06)) {
        const failed = newId()
        const res = await placeOrder(env, payload(failed, pick(['card_declined', 'insufficient_funds', 'expired_card'])), customer.id)
        if (res.status !== 200) throw new Error(`declined attempt refused: ${JSON.stringify(res.body)}`)
        orderTimes.set(failed, when)
        when += between(3, 12) * 60_000
      }
      const id = newId()
      const res = await placeOrder(env, payload(id, 'succeeded'), customer.id)
      if (res.status !== 200) throw new Error(`order refused: ${JSON.stringify(res.body)}`)
      orderTimes.set(id, when)
      placed.push({
        id,
        time: when,
        customer,
        method,
        lines,
        payLabel: payMethod === 'card' ? `my ${channel} card` : payMethod === 'fpx' ? `FPX (${channel})` : channel,
      })
    }
  }

  /* --------------------------------------------------- fulfilment, returns */

  const repos = new Map<string, Repository>()
  const repoOf = async (merchantId: string) => {
    if (!repos.has(merchantId)) repos.set(merchantId, await scopedTo(env, merchantId, `stf_demo_${merchantId}`))
    return repos.get(merchantId)!
  }
  const platform = await platformWide(env, 'stf_demo_platform')

  const partTimes = new Map<string, { updated: number; shipped?: number; delivered?: number }>()
  const refundTimes = new Map<string, number>()
  const refundsSeen = new Set<string>()
  /** Refunds written since the last call, dated `ms`. */
  const dateNewRefunds = (ms: number) => {
    for (const { id } of mem.raw.prepare(`SELECT id FROM refunds`).all() as { id: string }[]) {
      if (!refundsSeen.has(id)) (refundsSeen.add(id), refundTimes.set(id, ms))
    }
  }

  interface Delivered {
    order: Placed
    merchantId: string
    deliveredAt: number
    days: number
  }
  const delivered: Delivered[] = []
  const transit = (c: T.Country, m: ShipMethod) =>
    c === 'MY' ? (m === 'standard' ? between(2, 4) : between(1, 2)) : c === 'SG' ? (m === 'standard' ? between(3, 6) : between(2, 3)) : m === 'overnight' ? between(1, 2) : m === 'express' ? between(3, 5) : between(5, 9)
  const tracking = (carrier: string, c: T.Country) =>
    ({
      'J&T Express': `6${digits(11)}`,
      'Pos Laju': `E${pick([...'NRPE'])}${digits(9)}MY`,
      'Ninja Van': `NV${c}${code(10)}`,
      'DHL eCommerce': `MYCGU${digits(10)}`,
      'City-Link Express': digits(12),
      SingPost: `SG${digits(10)}`,
      'DHL Express': digits(10),
      FedEx: digits(12),
    })[carrier] ?? code(12)

  for (const order of placed) {
    const parts = (mem.raw.prepare(`SELECT merchant_id FROM order_fulfilments WHERE order_id = ?`).all(order.id) as { merchant_id: string }[]).map(
      (r) => r.merchant_id,
    )
    for (const merchantId of parts) {
      const repo = await repoOf(merchantId)
      const key = `${order.id}|${merchantId}`
      const cancelAt = order.time + between(0.05, 0.6) * DAY
      if (chance(0.025) && cancelAt < NOW) {
        await repo.fulfilment.cancel(order.id)
        partTimes.set(key, { updated: cancelAt })
        dateNewRefunds(cancelAt)
        continue
      }
      const shippedAt = order.time + between(0.3, 2) * DAY
      if (shippedAt > NOW) {
        partTimes.set(key, { updated: order.time })
        continue
      }
      const carrier = pick(T.CARRIERS[order.customer.country])
      await repo.fulfilment.ship(order.id, { carrier, tracking: tracking(carrier, order.customer.country) })
      const deliveredAt = shippedAt + transit(order.customer.country, order.method) * DAY
      if (deliveredAt > NOW) {
        partTimes.set(key, { updated: shippedAt, shipped: shippedAt })
        continue
      }
      await repo.fulfilment.deliver(order.id)
      partTimes.set(key, { updated: deliveredAt, shipped: shippedAt, delivered: deliveredAt })
      delivered.push({ order, merchantId, deliveredAt, days: Math.max(1, Math.round((deliveredAt - order.time) / DAY)) })
    }
  }

  const returnTimes = new Map<string, { created: number; decided?: number }>()
  /** user|product pairs whose unit came back: damaged ones get a review saying so, the others none. */
  const returned = new Map<string, T.Reason>()
  for (const part of delivered) {
    const openedAt = part.deliveredAt + between(1, 14) * DAY
    if (!chance(0.045) || openedAt > NOW - 0.2 * DAY) continue
    const reason = weighted<T.Reason>([
      ['damaged', 25],
      ['not_as_described', 20],
      ['changed_mind', 30],
      ['wrong_item', 10],
      ['other', 15],
    ])
    const user = userOf(part.order.customer)
    const res = await openReturn(env, user, part.order.id, { merchantId: part.merchantId, reason, note: pick(T.RETURN_NOTES[reason]) })
    if (res.status !== 201) throw new Error(`return refused: ${JSON.stringify(res.body)}`)
    const returnId = (res.body as { id: string }).id
    const times: { created: number; decided?: number } = { created: openedAt }
    returnTimes.set(returnId, times)
    const lineIds = part.order.lines.filter((l) => l.product.merchant_id === part.merchantId).map((l) => l.product.id)

    const decidedAt = openedAt + between(0.5, 3) * DAY
    if (decidedAt > NOW) continue
    times.decided = decidedAt
    const repo = await repoOf(part.merchantId)
    const approve = chance({ damaged: 0.95, wrong_item: 0.95, not_as_described: 0.7, changed_mind: 0.6, other: 0.9 }[reason])
    if (approve) {
      const [{ refundable }] = mem.raw
        .prepare(
          `SELECT (SELECT SUM(qty * unit_price_cents) FROM order_lines WHERE order_id = ? AND merchant_id = ?)
                - COALESCE((SELECT SUM(amount_minor) FROM refunds WHERE order_id = ? AND merchant_id = ?), 0) AS refundable`,
        )
        .all(part.order.id, part.merchantId, part.order.id, part.merchantId) as { refundable: number }[]
      await repo.returns.approve(returnId, { amountMinor: refundable, note: pick(T.APPROVE_NOTES) })
      dateNewRefunds(decidedAt)
      for (const id of lineIds) returned.set(`${user.id}|${id}`, reason)
    } else {
      await repo.returns.reject(returnId, { note: pick(T.REJECT_NOTES) })
    }
  }

  /* -------------------------------------------------------------- reviews */

  const reviewTimes = new Map<string, number>()
  const reviewed = new Set<string>()
  const reviewIdOf = (userId: string, productId: string) =>
    (mem.raw.prepare(`SELECT id FROM reviews WHERE user_id = ? AND product_id = ?`).get(userId, productId) as { id: string }).id
  const candidates: { part: Delivered; product: Product; key: string }[] = []

  for (const part of delivered) {
    for (const line of part.order.lines) {
      if (line.product.merchant_id !== part.merchantId) continue
      const key = `${part.order.customer.id}|${line.product.id}`
      if (reviewed.has(key)) continue
      const reason = returned.get(key)
      // Sent back for a reason other than damage: nothing left to review.
      if (reason && reason !== 'damaged') continue
      const writtenAt = part.deliveredAt + between(1, 21) * DAY
      if (!chance(reason ? 0.6 : 0.5) || writtenAt > NOW - 0.1 * DAY) {
        candidates.push({ part, product: line.product, key })
        continue
      }
      const damaged = reason === 'damaged'
      const rating = damaged
        ? chance(0.7)
          ? pick([1, 2])
          : pick([3, 4])
        : Math.min(5, Math.max(1, Math.round(line.product.quality + (rand() + rand() + rand() - 1.5) * 1.4)))
      const body = T.reviewBody(
        {
          rating,
          kind: line.product.kind,
          city: part.order.customer.place.city,
          daysToArrive: part.days,
          payment: part.order.payLabel,
          damaged,
        },
        rand,
      )
      const res = await saveReview(env, userOf(part.order.customer), line.product.id, { rating, body })
      if (res.status !== 200) throw new Error(`review refused: ${JSON.stringify(res.body)}`)
      reviewed.add(key)
      reviewTimes.set(reviewIdOf(part.order.customer.id, line.product.id), writtenAt)
    }
  }

  // Spam that got through and was hidden by the platform's moderators.
  for (const body of T.SPAM_REVIEWS) {
    const c = candidates.find((x) => !reviewed.has(x.key) && !returned.has(x.key) && x.part.deliveredAt < NOW - 3 * DAY)
    if (!c) break
    reviewed.add(c.key)
    await saveReview(env, userOf(c.part.order.customer), c.product.id, { rating: 5, body })
    const id = reviewIdOf(c.part.order.customer.id, c.product.id)
    await platform.moderation.hide(id)
    reviewTimes.set(id, c.part.deliveredAt + between(1, 3) * DAY)
  }

  /* ------------------------------------------------------------ questions */

  const questionTimes = new Map<string, { created: number; answered?: number }>()
  const asked = new Map<string, Set<string>>()
  const latestQuestion = (userId: string, productId: string) =>
    (
      mem.raw.prepare(`SELECT id FROM product_questions WHERE user_id = ? AND product_id = ? ORDER BY rowid DESC LIMIT 1`).get(userId, productId) as {
        id: string
      }
    ).id

  for (let i = 0; i < 110; i++) {
    const product = anyProduct()
    const used = asked.get(product.id) ?? new Set<string>()
    const qa = T.questionsFor(product.kind).find((x) => !used.has(x.q) && chance(0.5)) ?? T.questionsFor(product.kind).find((x) => !used.has(x.q))
    if (!qa) continue
    const askedAt = NOW - between(0.05, 180) * DAY
    const eligible = customers.filter((c) => c.signup < askedAt)
    if (!eligible.length) continue
    const asker = pick(eligible)
    const res = await askQuestion(env, userOf(asker), product.id, { body: qa.q })
    // 409: this shopper already has three waiting on this product, the cap doing its job.
    if (res.status === 409) continue
    if (res.status !== 201) throw new Error(`question refused: ${JSON.stringify(res.body)}`)
    used.add(qa.q)
    asked.set(product.id, used)
    const id = latestQuestion(asker.id, product.id)
    const times: { created: number; answered?: number } = { created: askedAt }
    questionTimes.set(id, times)
    const answeredAt = askedAt + between(0.1, 2.5) * DAY
    if (answeredAt < NOW && chance(0.93)) {
      await (await repoOf(product.merchant_id)).questions.answer(id, qa.a)
      times.answered = answeredAt
    }
  }
  for (const body of T.SPAM_QUESTIONS) {
    const product = anyProduct()
    const asker = pick(customers)
    if ((await askQuestion(env, userOf(asker), product.id, { body })).status !== 201) continue
    const id = latestQuestion(asker.id, product.id)
    await platform.moderation.hideQuestion(id)
    questionTimes.set(id, { created: NOW - between(5, 60) * DAY })
  }

  /* ---------------------------------------------------- back to the months */

  // The copy's ledgers are append-only like the real ones; this copy is thrown away after.
  mem.raw.prepare(`DROP TRIGGER refunds_no_update`).run()
  const u = (sql: string) => mem.raw.prepare(sql)
  const setOrder = u(`UPDATE orders SET created_at = ? WHERE id = ?`)
  for (const [id, ms] of orderTimes) setOrder.run(at(ms), id)
  const setPart = u(`UPDATE order_fulfilments SET updated_at = ?, shipped_at = ?, delivered_at = ? WHERE order_id = ? AND merchant_id = ?`)
  for (const [key, t] of partTimes) {
    const [orderId, merchantId] = key.split('|')
    setPart.run(at(t.updated), t.shipped ? at(t.shipped) : null, t.delivered ? at(t.delivered) : null, orderId!, merchantId!)
  }
  const setRefund = u(`UPDATE refunds SET created_at = ? WHERE id = ?`)
  for (const [id, ms] of refundTimes) setRefund.run(at(ms), id)
  const setReturn = u(`UPDATE return_requests SET created_at = ?, decided_at = ? WHERE id = ?`)
  for (const [id, t] of returnTimes) setReturn.run(at(t.created), t.decided ? at(t.decided) : null, id)
  const setReview = u(`UPDATE reviews SET created_at = ?, updated_at = ? WHERE id = ?`)
  for (const [id, ms] of reviewTimes) setReview.run(at(ms), at(ms), id)
  const setQuestion = u(`UPDATE product_questions SET created_at = ?, answered_at = ? WHERE id = ?`)
  for (const [id, t] of questionTimes) setQuestion.run(at(t.created), t.answered ? at(t.answered) : null, id)

  /* ------------------------------------------------------------ write out */

  const quote = (v: unknown) =>
    v === null || v === undefined ? 'NULL' : typeof v === 'number' || typeof v === 'bigint' ? String(v) : `'${String(v).replace(/'/g, "''")}'`
  const TABLES: [string, string][] = [
    ['users', `substr(id, 1, 9) = 'usr_demo_'`],
    ['orders', DEMO],
    ['order_lines', DEMO_ORDERS],
    ['order_fulfilments', DEMO_ORDERS],
    ['refunds', DEMO_ORDERS],
    ['return_requests', DEMO_ORDERS],
    ['reviews', DEMO],
    ['product_questions', DEMO],
  ]
  const statements: string[] = []
  const counts: Record<string, number> = {}
  for (const [table, where] of TABLES) {
    const rows = mem.raw.prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY rowid`).all() as Record<string, unknown>[]
    counts[table] = rows.length
    for (const row of rows) {
      // These units never left the real stock (only this copy's), so a cancel must not put any back.
      if (table === 'order_fulfilments') row.stock_taken = 0
      const cols = Object.keys(row)
      statements.push(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => quote(row[c])).join(', ')});`)
    }
  }

  // Proof it applies: into a second fresh copy, with the real schema's every CHECK and foreign key.
  const check = copyOf(merchants, products)
  for (const s of statements) check.raw.prepare(s).run()

  const stats = (sql: string) => check.raw.prepare(sql).all()
  const summary = {
    parts: stats(`SELECT status, COUNT(*) AS parts FROM order_fulfilments GROUP BY status`),
    payments: stats(`SELECT payment_status, payment_method, COUNT(*) AS orders FROM orders GROUP BY 1, 2`),
    ratings: stats(`SELECT rating, COUNT(*) AS reviews FROM reviews GROUP BY rating`),
    returns: stats(`SELECT status, reason, COUNT(*) AS returns FROM return_requests GROUP BY 1, 2`),
    questions: stats(`SELECT answer IS NOT NULL AS answered, hidden, COUNT(*) AS questions FROM product_questions GROUP BY 1, 2`),
    months: stats(
      `SELECT substr(created_at, 1, 7) AS month, COUNT(*) AS orders, SUM(total_cents) / 100 AS usd FROM orders WHERE payment_status = 'succeeded' GROUP BY 1`,
    ),
  }

  // And proof the removal script takes all of it out again, leaving the refunds guard in place.
  check.raw.exec(readFileSync(path.join(ROOT, 'worker/seeds/demo-remove.sql'), 'utf8'))
  for (const [table] of TABLES) {
    const [{ n }] = check.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).all() as { n: number }[]
    if (n) throw new Error(`demo-remove.sql left ${n} rows in ${table}`)
  }
  if (!check.raw.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'refunds_no_delete'`).get()) {
    throw new Error('demo-remove.sql did not restore refunds_no_delete')
  }
  const header = [
    `-- Demo data for ${DB}, generated ${at(NOW)} UTC by scripts/seed-demo.ts.`,
    `-- ${Object.entries(counts)
      .map(([t, n]) => `${t} ${n}`)
      .join(', ')}.`,
    '-- Remove it with seeds/demo-remove.sql. Applies once: a second run fails on the first',
    '-- duplicate id and D1 rolls the whole file back.',
    '',
  ]
  mkdirSync(path.dirname(OUT), { recursive: true })
  writeFileSync(OUT, header.join('\n') + statements.join('\n') + '\n')

  console.log(`Wrote ${statements.length} statements to ${path.relative(ROOT, OUT)}`)
  console.table(counts)
  for (const table of Object.values(summary)) console.table(table)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
