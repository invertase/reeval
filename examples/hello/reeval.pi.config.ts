// The coding evals under pi: `reeval run --config reeval.pi.config.ts`. It
// needs GOOGLE_GENERATIVE_AI_API_KEY (a Gemini API key, for its google provider). The main config's
// profiles limit their harness to Cursor, so this config has none.
import { defineConfig } from 'reeval'
import { docker } from 'reeval/sandbox'
import { pim } from './evals/harnesses.ts'

export default defineConfig({
  include: ['evals/hello.eval.ts', 'evals/skill.eval.ts', 'evals/brokering.eval.ts'],
  harness: pim,
  sandbox: docker(),
  judge: { model: 'google/gemini-3.8-flash', threshold: 0.8 },
  timeout: '15m',
})
