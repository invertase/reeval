// The coding evals under Codex: `es run --config es.codex.config.ts`. It needs OPENAI_API_KEY
// (an OpenAI API key). The main config's profiles limit their harness to Cursor, so this config has
// none.
import { defineConfig } from 'evalsuite'
import { docker } from 'evalsuite/sandbox'
import { cx } from './evals/harnesses.ts'

export default defineConfig({
  include: ['evals/hello.es.ts', 'evals/skill.es.ts', 'evals/brokering.es.ts'],
  harness: cx,
  sandbox: docker(),
  judge: { model: 'google/gemini-3.8-flash', threshold: 0.8 },
  timeout: '15m',
})
