<script setup lang="ts">
// Shoppers' questions about products. A merchant sees the questions about its
// own products, unanswered first, and answers (or edits an answer) here; only an
// answered question shows on the product page. The platform reads every one and
// can hide or unhide it (audited), but never answers for a seller. Hidden
// questions stay listed, marked, so they can be restored.
import { onMounted, ref } from 'vue'
import { answerQuestion, listQuestions, setQuestionHidden, isError, type Scope, type StaffQuestion } from '../api'
import { placed } from '../orders'

const props = defineProps<{ scope: Scope }>()

const questions = ref<StaffQuestion[]>([])
const error = ref<string | null>(null)
const actionError = ref<string | null>(null)
const loading = ref(true)
const busy = ref<string | null>(null)
/** The answer being written, per question id; absent when the row is not being edited. */
const drafts = ref<Record<string, string>>({})

async function load() {
  const { body } = await listQuestions(props.scope)
  if (isError(body)) error.value = body.error
  else if ('questions' in body) questions.value = body.questions
  else error.value = 'Something went wrong. Reload and try again.'
  loading.value = false
}
onMounted(load)

const edit = (q: StaffQuestion) => (drafts.value[q.id] = q.answer ?? '')
const cancel = (q: StaffQuestion) => delete drafts.value[q.id]

async function save(q: StaffQuestion) {
  busy.value = q.id
  actionError.value = null
  const { body } = await answerQuestion(q.id, drafts.value[q.id] ?? '')
  busy.value = null
  if (isError(body)) actionError.value = body.error
  else if ('answer' in body) {
    q.answer = body.answer
    q.answeredAt = body.answeredAt
    cancel(q)
  }
}

async function toggle(q: StaffQuestion) {
  busy.value = q.id
  actionError.value = null
  const { body } = await setQuestionHidden(q.id, !q.hidden)
  busy.value = null
  if (isError(body)) actionError.value = body.error
  else if ('hidden' in body) q.hidden = body.hidden
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <header>
      <h1 class="font-display text-xl font-bold text-text-primary">Questions</h1>
      <p class="mt-1 text-sm text-text-secondary">
        <template v-if="scope === 'platform'">Every product's questions. Hiding one takes it off the product page.</template>
        <template v-else>What shoppers ask about your products. A question shows on the product page once you answer it.</template>
      </p>
    </header>

    <p v-if="actionError" class="text-sm text-accent-amber" role="alert">{{ actionError }}</p>
    <p v-if="error" class="text-sm text-accent-amber">{{ error }}</p>
    <p v-else-if="loading" class="text-text-secondary">Loading…</p>
    <p v-else-if="!questions.length" class="text-sm text-text-secondary">No questions yet.</p>
    <ul v-else class="flex flex-col gap-3">
      <li v-for="q in questions" :key="q.id" class="card p-4" :class="q.hidden ? 'opacity-60' : ''">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span class="font-medium text-text-primary">{{ q.productTitle || q.productId }}</span>
          <span class="text-text-secondary">{{ q.author }}</span>
          <span class="nums text-xs text-text-muted">{{ placed(q.createdAt) }}</span>
          <span v-if="!q.answer" class="rounded-full border border-accent-amber px-2 py-0.5 text-xs text-accent-amber">Needs an answer</span>
          <span v-if="q.hidden" class="rounded-full border border-border-strong px-2 py-0.5 text-xs text-text-secondary">Hidden</span>
          <span v-if="scope === 'platform'" class="font-mono text-xs text-text-muted">{{ q.merchantId }}</span>
          <button
            v-if="scope === 'platform'"
            type="button"
            class="btn-ghost ml-auto px-3 py-1 text-xs"
            :disabled="busy === q.id"
            @click="toggle(q)"
          >{{ q.hidden ? 'Unhide' : 'Hide' }}</button>
        </div>
        <p class="mt-2 text-sm text-text-primary">{{ q.body }}</p>

        <form v-if="q.id in drafts" class="mt-3 flex flex-col gap-2" @submit.prevent="save(q)">
          <textarea
            v-model="drafts[q.id]"
            class="input w-full"
            rows="3"
            maxlength="1000"
            aria-label="Your answer"
            placeholder="Answer for shoppers"
          ></textarea>
          <div class="flex gap-2">
            <button type="submit" class="btn-primary px-3 py-1 text-xs" :disabled="busy === q.id || !drafts[q.id]?.trim()">Save answer</button>
            <button type="button" class="btn-ghost px-3 py-1 text-xs" :disabled="busy === q.id" @click="cancel(q)">Cancel</button>
          </div>
        </form>
        <template v-else>
          <p v-if="q.answer" class="mt-2 border-l-2 border-border-strong pl-3 text-sm text-text-secondary">{{ q.answer }}</p>
          <button
            v-if="scope === 'merchant'"
            type="button"
            class="btn-ghost mt-3 px-3 py-1 text-xs"
            @click="edit(q)"
          >{{ q.answer ? 'Edit answer' : 'Answer' }}</button>
        </template>
      </li>
    </ul>
  </div>
</template>
