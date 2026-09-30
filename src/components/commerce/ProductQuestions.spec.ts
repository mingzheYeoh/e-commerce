import { beforeEach, describe, it, expect, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ProductQuestions from './ProductQuestions.vue'
import { fetchQuestions, askQuestion, type Question, type QuestionPage } from '@/lib/uploads'

vi.mock('@/lib/uploads', async (actual) => ({
  ...(await actual<typeof import('@/lib/uploads')>()),
  fetchQuestions: vi.fn(),
  askQuestion: vi.fn(),
}))
vi.mock('vue-router', async (actual) => ({
  ...(await actual<typeof import('vue-router')>()),
  useRoute: () => ({ fullPath: '/products/prd_1' }),
}))

const answered: Question = {
  id: 'qst_1',
  body: 'Does it come with a case?',
  answer: 'Yes, a hard case is in the box.',
  seller: 'Acme',
  askedAt: '2026-09-20 03:06:30',
  answeredAt: '2026-09-21 03:06:30',
}
const waiting: Question = { ...answered, id: 'qst_2', body: 'Can I use it with two phones?', answer: null, answeredAt: null }
const page = (viewer: QuestionPage['viewer']): QuestionPage => ({ page: 0, next: null, questions: [answered], viewer })

async function render() {
  const w = mount(ProductQuestions, {
    props: { productId: 'prd_1' },
    global: { stubs: { RouterLink: { props: ['to'], template: '<a :data-to="JSON.stringify(to)"><slot /></a>' } } },
  })
  await flushPromises()
  return w
}

describe('product questions', () => {
  beforeEach(() => {
    vi.mocked(fetchQuestions).mockReset()
    vi.mocked(askQuestion).mockReset()
  })

  it('shows answered questions, and signed out an invitation back to this page instead of a form', async () => {
    vi.mocked(fetchQuestions).mockResolvedValue({ ok: true, data: page(null) })
    const w = await render()
    expect(w.text()).toContain('Does it come with a case?')
    expect(w.text()).toContain('Yes, a hard case is in the box.')
    expect(w.text()).toContain('Answered by Acme')
    expect(w.find('form').exists()).toBe(false)
    expect(JSON.parse(w.find('a').attributes('data-to')!)).toEqual({ path: '/account', query: { next: '/products/prd_1' } })
  })

  it("marks the viewer's own unanswered question as waiting, and asks a new one", async () => {
    vi.mocked(fetchQuestions).mockResolvedValue({ ok: true, data: page({ pending: [waiting] }) })
    vi.mocked(askQuestion).mockResolvedValue({ ok: true, data: { ok: true } })
    const w = await render()
    expect(w.text()).toContain('Can I use it with two phones?')
    expect(w.text()).toContain("Awaiting the seller's answer")
    await w.find('textarea').setValue('Is the battery replaceable?')
    await w.find('form').trigger('submit')
    await flushPromises()
    expect(askQuestion).toHaveBeenCalledWith('prd_1', 'Is the battery replaceable?')
    expect(fetchQuestions).toHaveBeenCalledTimes(2)
  })

  it('does not send a question that is too short', async () => {
    vi.mocked(fetchQuestions).mockResolvedValue({ ok: true, data: page({ pending: [] }) })
    const w = await render()
    await w.find('textarea').setValue('Why?')
    await w.find('form').trigger('submit')
    await flushPromises()
    expect(askQuestion).not.toHaveBeenCalled()
    expect(w.text()).toContain('at least 10 characters')
  })
})
