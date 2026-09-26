import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils'
import ReturnDetail from './ReturnDetail.vue'
import Returns from './Returns.vue'
import Reviews from './Reviews.vue'
import {
  getReturn,
  listReturns,
  approveReturn,
  rejectReturn,
  listReviews,
  setReviewHidden,
  type ReturnDetail as Detail,
  type StaffReview,
} from '../api'

vi.mock('../api', async (actual) => ({
  ...(await actual<typeof import('../api')>()),
  getReturn: vi.fn(),
  listReturns: vi.fn(),
  approveReturn: vi.fn(async () => ({ status: 200, body: {} })),
  rejectReturn: vi.fn(async () => ({ status: 200, body: {} })),
  listReviews: vi.fn(),
  setReviewHidden: vi.fn(async () => ({ status: 200, body: { id: 'rev_1', hidden: true } })),
}))

const detail: Detail = {
  id: 'ret_1',
  orderId: 'NX-4K2P9',
  merchantId: 'mch_a',
  reason: 'damaged',
  note: 'Dented corner',
  status: 'open',
  refundMinor: null,
  currency: 'USD',
  decisionNote: null,
  decidedAt: null,
  createdAt: '2026-09-25 10:00:00',
  deliveredAt: '2026-09-24 10:00:00',
  lines: [{ productId: 'p1', finish: null, sku: 'S1', title: 'Phone', qty: 2, unitMinor: 1000, paid: 2000, refundedMinor: 0 }],
  refundable: 2000,
  photos: ['/api/merchant/return-photos/returns/ret_1/ph_a.webp'],
}

const stubs = { global: { stubs: { RouterLink: RouterLinkStub } } }
const button = (w: ReturnType<typeof mount>, text: string) => w.findAll('button').find((b) => b.text() === text)

describe('a return, in the console', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows the request, the photos and what is left to refund', async () => {
    vi.mocked(getReturn).mockResolvedValue({ status: 200, body: detail })
    const w = mount(ReturnDetail, { props: { id: 'ret_1', scope: 'merchant' }, ...stubs })
    await flushPromises()
    expect(w.text()).toContain('Arrived damaged')
    expect(w.text()).toContain('Dented corner')
    expect(w.text()).toContain('$20.00')
    expect(w.find('img').attributes('src')).toBe(detail.photos[0])
    expect(getReturn).toHaveBeenCalledWith('merchant', 'ret_1')
  })

  it('approves the amount typed, in minor units', async () => {
    vi.mocked(getReturn).mockResolvedValue({ status: 200, body: detail })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const w = mount(ReturnDetail, { props: { id: 'ret_1', scope: 'merchant' }, ...stubs })
    await flushPromises()
    await w.find('#return-amount').setValue('12.50')
    await w.find('#return-note').setValue('Sorry')
    await button(w, 'Approve and refund')!.trigger('click')
    await flushPromises()
    expect(approveReturn).toHaveBeenCalledWith('ret_1', 1250, 'Sorry')
  })

  it('will not reject without a note', async () => {
    vi.mocked(getReturn).mockResolvedValue({ status: 200, body: detail })
    const w = mount(ReturnDetail, { props: { id: 'ret_1', scope: 'merchant' }, ...stubs })
    await flushPromises()
    await button(w, 'Reject')!.trigger('click')
    expect(rejectReturn).not.toHaveBeenCalled()
    expect(w.text()).toContain('needs a note')
    await w.find('#return-note').setValue('Outside policy')
    await button(w, 'Reject')!.trigger('click')
    await flushPromises()
    expect(rejectReturn).toHaveBeenCalledWith('ret_1', 'Outside policy')
  })

  it('is read-only for the platform', async () => {
    vi.mocked(getReturn).mockResolvedValue({ status: 200, body: { ...detail, photos: ['/api/platform/return-photos/returns/ret_1/ph_a.webp'] } })
    const w = mount(ReturnDetail, { props: { id: 'ret_1', scope: 'platform' }, ...stubs })
    await flushPromises()
    expect(button(w, 'Approve and refund')).toBeUndefined()
    expect(button(w, 'Reject')).toBeUndefined()
    expect(getReturn).toHaveBeenCalledWith('platform', 'ret_1')
  })

  it('lists requests by status', async () => {
    vi.mocked(listReturns).mockResolvedValue({ status: 200, body: { returns: [detail] } })
    const w = mount(Returns, { props: { scope: 'merchant' }, ...stubs })
    await flushPromises()
    expect(listReturns).toHaveBeenCalledWith('merchant', 'open')
    expect(w.text()).toContain('NX-4K2P9')
  })
})

describe('reviews, in the console', () => {
  const review: StaffReview = {
    id: 'rev_1',
    productId: 'p1',
    productTitle: 'Phone',
    merchantId: 'mch_a',
    rating: 2,
    body: 'Meh',
    hidden: false,
    author: 'Ada L.',
    photos: [],
    createdAt: '2026-09-25 10:00:00',
    updatedAt: '2026-09-25 10:00:00',
  }
  beforeEach(() => vi.clearAllMocks())

  it('gives a merchant no way to hide a review', async () => {
    vi.mocked(listReviews).mockResolvedValue({ status: 200, body: { reviews: [review] } })
    const w = mount(Reviews, { props: { scope: 'merchant' }, ...stubs })
    await flushPromises()
    expect(w.text()).toContain('Ada L.')
    expect(button(w, 'Hide')).toBeUndefined()
  })

  it('lets the platform hide one', async () => {
    vi.mocked(listReviews).mockResolvedValue({ status: 200, body: { reviews: [review] } })
    const w = mount(Reviews, { props: { scope: 'platform' }, ...stubs })
    await flushPromises()
    await button(w, 'Hide')!.trigger('click')
    await flushPromises()
    expect(setReviewHidden).toHaveBeenCalledWith('rev_1', true)
  })
})
