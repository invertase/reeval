// The coding evals under Claude Code: `es run --config es.claude.config.ts`. The main config's
// profiles limit their harness to Cursor, so this config has none.
import { defineConfig } from 'evalsuite'
import { docker } from 'evalsuite/sandbox'
import { claude } from './evals/harnesses.ts'

export default defineConfig({
  include: ['evals/hello.es.ts', 'evals/skill.es.ts', 'evals/brokering.es.ts'],
  harness: claude,
  sandbox: docker(),
  judge: { model: 'google/gemini-3.8-flash', threshold: 0.8 },
  timeout: '15m',
})
