// The coding evals under Claude Code: `reeval run --config reeval.claude.config.ts`. The main config's
// profiles limit their harness to Cursor, so this config has none.
import { defineConfig } from 'reeval'
import { claude } from './evals/harnesses.ts'

export default defineConfig({
  include: ['evals/hello.eval.ts', 'evals/skill.eval.ts', 'evals/brokering.eval.ts'],
  harness: claude,
  judge: { model: 'google/gemini-3.8-flash', threshold: 0.8 },
  timeout: '15m',
})
