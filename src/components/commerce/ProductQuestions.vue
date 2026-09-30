<script setup lang="ts">
/**
 * Questions shoppers asked about one product, with the seller's answers. Only
 * answered questions are listed for everyone; a signed-in shopper also sees
 * their own unanswered ones, marked as waiting. Who is signed in is the
 * server's answer (`viewer`), as with reviews. All text is interpolated, never
 * rendered as HTML.
 *
 * A waiting question can be rewritten or withdrawn by its asker; once answered
 * it stays as asked, because the answer was written to it.
 */
import { ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { fetchQuestions, askQuestion, editQuestion, deleteQuestion, type Question, type QuestionPage } from '@/lib/uploads'

const props = defineProps<{ productId: string }>()
const route = useRoute()

const MIN = 10
const MAX = 300

const data = ref<QuestionPage | null>(null)
const questions = ref<Question[]>([])
const loadError = ref('')
const busy = ref(false)
const error = ref('')
const asked = ref(false)
const body = ref('')

async function load() {
  const res = await fetchQuestions(props.productId)
  if (!res.ok || !Array.isArray(res.data.questions)) {
    loadError.value = res.ok ? '' : res.error
    return
  }
  loadError.value = ''
  data.value = res.data
  questions.value = res.data.questions
}

watch(() => props.productId, load, { immediate: true })

async function more() {
  if (data.value?.next == null) return
  const res = await fetchQuestions(props.productId, data.value.next)
  if (!res.ok) return
  data.value = { ...res.data, viewer: data.value.viewer }
  questions.value = [...questions.value, ...res.data.questions]
}

async function submit() {
  if (body.value.trim().length < MIN) {
    error.value = `A question is at least ${MIN} characters.`
    return
  }
  busy.value = true
  error.value = ''
  const res = await askQuestion(props.productId, body.value)
  busy.value = false
  if (!res.ok) {
    error.value = res.error
    return
  }
  body.value = ''
  asked.value = true
  await load()
}

/** The pending question being rewritten, or about to be withdrawn: one at a time. */
const editing = ref<string | null>(null)
const withdrawing = ref<string | null>(null)
const draft = ref('')
const rowError = ref('')

function startEdit(q: Question) {
  withdrawing.value = null
  rowError.value = ''
  editing.value = q.id
  draft.value = q.body
}

function stop() {
  editing.value = null
  withdrawing.value = null
  rowError.value = ''
}

/** Either change reloads the list, so what is shown is what the server kept. */
async function change(run: () => ReturnType<typeof deleteQuestion>) {
  busy.value = true
  rowError.value = ''
  const res = await run()
  busy.value = false
  if (!res.ok) {
    // Most often the seller answered in the meantime: reload to show it.
    rowError.value = res.error
    await load()
    return
  }
  stop()
  await load()
}

function saveEdit(id: string) {
  if (draft.value.trim().length < MIN) {
    rowError.value = `A question is at least ${MIN} characters.`
    return
  }
  return change(() => editQuestion(id, draft.value))
}

const day = (at: string) =>
  new Date(at.replace(' ', 'T') + 'Z').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
</script>

<template>
  <section id="questions" class="mt-16 border-t border-border-hairline pt-10" aria-labelledby="questions-heading">
    <h2 id="questions-heading" class="text-xl font-bold">Questions</h2>
    <p v-if="loadError" class="mt-4 text-sm text-text-secondary">Questions could not be loaded. {{ loadError }}</p>

    <!-- Asking one -->
    <div v-if="data" class="mt-6">
      <form v-if="data.viewer" class="rounded-card border border-border-hairline bg-surface-1 p-5" @submit.prevent="submit">
        <h3 class="text-sm font-semibold">Ask a question</h3>
        <textarea
          v-model="body"
          :maxlength="MAX"
          rows="3"
          class="input mt-3 w-full"
          placeholder="Something the page does not say about this product"
          aria-label="Your question"
        ></textarea>
        <p class="mt-1 text-right text-xs text-text-muted">{{ body.length }}/{{ MAX }}</p>
        <p v-if="error" class="mt-2 text-xs text-accent-red" role="alert">{{ error }}</p>
        <p v-else-if="asked" class="mt-2 text-xs text-text-secondary" role="status">
          Sent. It appears on this page once the seller answers it.
        </p>
        <div class="mt-3">
          <button type="submit" class="btn-primary" :disabled="busy">Ask</button>
        </div>
      </form>
      <p v-else class="text-sm text-text-secondary">
        <RouterLink :to="{ path: '/account', query: { next: route.fullPath } }" class="text-accent hover:underline">Sign in</RouterLink>
        to ask the seller a question.
      </p>
    </div>

    <!-- The viewer's own, still waiting -->
    <ul v-if="data?.viewer?.pending.length" class="mt-6 flex flex-col gap-3">
      <li v-for="q in data.viewer.pending" :key="q.id" class="rounded-card border border-dashed border-border-strong p-4">
        <form v-if="editing === q.id" @submit.prevent="saveEdit(q.id)">
          <textarea v-model="draft" :maxlength="MAX" rows="2" class="input w-full" aria-label="Edit your question"></textarea>
          <p class="mt-1 text-right text-xs text-text-muted">{{ draft.length }}/{{ MAX }}</p>
          <div class="mt-2 flex gap-2">
            <button type="submit" class="btn-primary" :disabled="busy">Save</button>
            <button type="button" class="btn-ghost" @click="stop">Cancel</button>
          </div>
        </form>
        <template v-else>
          <p class="text-sm">{{ q.body }}</p>
          <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span class="text-accent-amber">Awaiting the seller's answer</span>
            <template v-if="withdrawing === q.id">
              <span class="text-text-secondary">Withdraw this question?</span>
              <button type="button" class="font-medium text-accent-red hover:underline" :disabled="busy" @click="change(() => deleteQuestion(q.id))">
                Withdraw
              </button>
              <button type="button" class="text-text-secondary hover:text-text-primary" @click="stop">Keep it</button>
            </template>
            <template v-else>
              <button type="button" class="text-text-secondary hover:text-text-primary" @click="startEdit(q)">Edit</button>
              <button type="button" class="text-text-secondary hover:text-text-primary" @click="stop(); withdrawing = q.id">Withdraw</button>
            </template>
          </div>
        </template>
        <p v-if="rowError && (editing === q.id || withdrawing === q.id)" class="mt-2 text-xs text-accent-red" role="alert">
          {{ rowError }}
        </p>
      </li>
    </ul>

    <!-- Reading them -->
    <ul v-if="questions.length" class="mt-8 divide-y divide-border-hairline">
      <li v-for="q in questions" :key="q.id" class="py-5 first:pt-0">
        <p class="text-sm font-medium">{{ q.body }}</p>
        <p class="mt-2 text-sm text-text-secondary">{{ q.answer }}</p>
        <p class="mt-1 text-xs text-text-muted">
          Answered by {{ q.seller || 'the seller' }}<template v-if="q.answeredAt"> · {{ day(q.answeredAt) }}</template>
        </p>
      </li>
    </ul>
    <p v-else-if="data" class="mt-6 text-sm text-text-muted">No answered questions yet.</p>
    <button v-if="data?.next != null" type="button" class="btn-ghost mt-4" @click="more">More questions</button>
  </section>
</template>
