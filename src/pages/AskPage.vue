<script setup lang="ts">
import { ref } from 'vue'
import { RouterLink } from 'vue-router'
import AskPanel from '@/components/commerce/AskPanel.vue'
import ChatAssistant from '@/components/commerce/ChatAssistant.vue'
import { products } from '@/data/products'

/**
 * Two modes, because they demonstrate different things and fail differently.
 *
 * "Ask" is single-shot retrieval with hard grounding: one question, one cited
 * answer, and a plain refusal when the catalogue does not cover it. "Assistant"
 * is an agent that chooses tools and can take several steps, which is more
 * capable and correspondingly harder to keep honest — so it shows its lookups.
 */
const mode = ref<'ask' | 'assistant'>('assistant')

const MODES = [
  { id: 'assistant' as const, label: 'Assistant', hint: 'Converses, picks tools, shows its lookups' },
  { id: 'ask' as const, label: 'Single question', hint: 'One cited answer, or a refusal' },
]
</script>

<template>
  <div class="pt-16">
    <div class="mx-auto max-w-[1600px] px-4 py-10 md:px-8 md:py-16">
      <nav class="mb-8 text-sm text-text-secondary" aria-label="Breadcrumb">
        <RouterLink to="/" class="transition-colors hover:text-text-primary">Home</RouterLink>
        <span class="mx-2 text-text-muted">/</span>
        <span class="text-text-primary">Ask</span>
      </nav>

      <header class="mb-8 max-w-2xl">
        <h1 class="text-3xl font-bold md:text-4xl">Ask about the catalogue</h1>
        <p class="mt-3 text-text-secondary">
          Answers come from the published specifications of all {{ products.length }} products —
          charging speeds, ports, battery figures, what pairs with what. Every claim links to the
          product it came from, and anything the catalogue does not cover is declined rather than
          guessed at.
        </p>
      </header>

      <div class="mx-auto mb-8 max-w-3xl">
        <div
          class="inline-flex rounded-card border border-border-hairline bg-surface-1 p-1"
          role="tablist"
        >
          <button
            v-for="m in MODES"
            :key="m.id"
            type="button"
            role="tab"
            :aria-selected="mode === m.id"
            :title="m.hint"
            class="rounded px-3.5 py-1.5 text-sm font-medium transition-colors"
            :class="
              mode === m.id
                ? 'bg-accent text-white'
                : 'text-text-secondary hover:text-text-primary'
            "
            @click="mode = m.id"
          >
            {{ m.label }}
          </button>
        </div>
      </div>

      <ChatAssistant v-if="mode === 'assistant'" />
      <AskPanel v-else />
    </div>
  </div>
</template>
