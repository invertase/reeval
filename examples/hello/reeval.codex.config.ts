// The coding evals under Codex: `reeval run --config reeval.codex.config.ts`. It needs OPENAI_API_KEY
// (an OpenAI API key). The main config's profiles limit their harness to Cursor, so this config has
// none.
import { defineConfig } from 'reeval'
import { cx } from './evals/harnesses.ts'

export default defineConfig({
  include: ['evals/hello.eval.ts', 'evals/skill.eval.ts', 'evals/brokering.eval.ts'],
  harness: cx,
  judge: { model: 'google/gemini-3.8-flash', threshold: 0.8 },
  timeout: '15m',
})
