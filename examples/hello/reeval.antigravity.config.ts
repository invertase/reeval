// The coding evals under the Antigravity CLI: `es run --config es.antigravity.config.ts`. It
// needs GEMINI_API_KEY (a Gemini API key; Google sign-in is never used). The main config's
// profiles limit their harness to Cursor, so this config has none.
import { defineConfig } from 'evalsuite'
import { docker } from 'evalsuite/sandbox'
import { agy } from './evals/harnesses.ts'

export default defineConfig({
  include: ['evals/hello.es.ts', 'evals/skill.es.ts', 'evals/brokering.es.ts'],
  harness: agy,
  sandbox: docker(),
  judge: { model: 'google/gemini-3.8-flash', threshold: 0.8 },
  timeout: '15m',
})
