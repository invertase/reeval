// The coding evals under Grok Build: `reeval run --config reeval.grok.config.ts`. It needs
// XAI_API_KEY (an xAI API key). The main config's profiles limit their harness to Cursor, so this
// config has none.
import { defineConfig } from 'reeval'
import { grok } from './evals/harnesses.ts'

export default defineConfig({
  include: ['evals/hello.eval.ts', 'evals/skill.eval.ts', 'evals/brokering.eval.ts'],
  harness: grok,
  judge: { model: 'google/gemini-3.8-flash', threshold: 0.8 },
  timeout: '15m',
})
