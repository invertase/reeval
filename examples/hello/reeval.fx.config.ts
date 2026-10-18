// The coding evals under fx: `reeval run --config reeval.fx.config.ts`. It needs AI_GATEWAY_API_KEY
// (a Vercel AI Gateway key). The main config's profiles limit their harness to Cursor, so this
// config has none.
import { defineConfig } from 'reeval'
import { fxGateway } from './evals/harnesses.ts'

export default defineConfig({
  include: ['evals/hello.eval.ts', 'evals/skill.eval.ts', 'evals/brokering.eval.ts'],
  harness: fxGateway,
  judge: { model: 'google/gemini-3.8-flash', threshold: 0.8 },
  timeout: '15m',
})
