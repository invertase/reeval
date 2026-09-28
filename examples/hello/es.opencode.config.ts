// The coding evals under OpenCode: `es run --config es.opencode.config.ts`. Its model,
// google/gemini-3.8-flash, needs GOOGLE_GENERATIVE_AI_API_KEY; another provider's model (such as
// anthropic/claude-haiku-4-5) needs that provider's key. The main config's profiles limit their
// harness to Cursor, so this config has none.
import { defineConfig } from 'evalsuite'
import { docker } from 'evalsuite/sandbox'
import { oc } from './evals/harnesses.ts'

export default defineConfig({
  include: ['evals/hello.es.ts', 'evals/skill.es.ts', 'evals/brokering.es.ts'],
  harness: oc,
  sandbox: docker(),
  judge: { model: 'google/gemini-3.8-flash', threshold: 0.8 },
  timeout: '15m',
})
