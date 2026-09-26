import { beforeEach, describe, it, expect, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ProductReviews from './ProductReviews.vue'
import { fetchReviews, saveReview, type ReviewPage } from '@/lib/uploads'

vi.mock('@/lib/uploads', async (actual) => ({
  ...(await actual<typeof import('@/lib/uploads')>()),
  fetchReviews: vi.fn(),
  saveReview: vi.fn(),
}))

const review = {
  id: 'rev_1',
  author: 'Ada L.',
  rating: 4,
  body: 'Warm and clear.',
  photos: [{ large: 'https://api.test/media/u/reviews/rev_1/ph_a-1600.webp', thumb: 'https://api.test/media/u/reviews/rev_1/ph_a-400.webp' }],
  createdAt: '2026-09-20 03:06:30',
  updatedAt: '2026-09-20 03:06:30',
}
const page = (viewer: ReviewPage['viewer']): ReviewPage => ({ average: 4, count: 1, page: 0, next: null, reviews: [review], viewer })

async function render() {
  const w = mount(ProductReviews, { props: { productId: 'prd_1' }, global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } } })
  await flushPromises()
  return w
}

describe('product reviews', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(saveReview).mockReset()
    vi.mocked(fetchReviews).mockReset()
  })

  it('shows the average, the count and each review with its author and photos', async () => {
    vi.mocked(fetchReviews).mockResolvedValue({ ok: true, data: page(null) })
    const w = await render()
    expect(w.text()).toContain('4.0 out of 5')
    expect(w.text()).toContain('1 review')
    expect(w.text()).toContain('Ada L.')
    expect(w.text()).toContain('Warm and clear.')
    expect(w.find('img').attributes('src')).toBe(review.photos[0].thumb)
    // Signed out: an invitation, not a form.
    expect(w.find('form').exists()).toBe(false)
    expect(w.text()).toContain('Sign in')
  })

  it('offers the form only to an account whose order was delivered', async () => {
    vi.mocked(fetchReviews).mockResolvedValue({ ok: true, data: page({ eligible: false, review: null }) })
    const w = await render()
    expect(w.find('form').exists()).toBe(false)
    expect(w.text()).toContain('once your order of it has been delivered')
  })

  it('saves a rating and text, and shows the saved review', async () => {
    vi.mocked(fetchReviews).mockResolvedValue({ ok: true, data: page({ eligible: true, review: null }) })
    vi.mocked(saveReview).mockResolvedValue({ ok: true, data: { ...review, id: 'rev_2', author: 'Me M.', body: 'Mine', hidden: false } })
    const w = await render()
    await w.find('input[value="5"]').setValue(true)
    await w.find('textarea').setValue('Mine')
    await w.find('form').trigger('submit')
    await flushPromises()
    expect(saveReview).toHaveBeenCalledWith('prd_1', 5, 'Mine')
    expect(fetchReviews).toHaveBeenCalledTimes(2)
  })
})
