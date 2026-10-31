// reeval evaluating agents that use reeval. Each topic is a folder of evals; see evals/README.md.
// These run real agents and cost money: nothing in `pnpm test` or CI runs them.
import { defineConfig } from 'reeval'
import { cursor } from 'reeval/harness'

export default defineConfig({
  include: ['evals/*/*.eval.ts'],
  harnesses: cursor({ model: 'composer-2.5', params: { fast: 'false' } }),
  judge: { model: 'google/gemini-3.8-flash', threshold: 0.8 },
  timeout: '15m',
})
