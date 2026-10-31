import { defineConfig } from 'reeval'
import { direct, vercel } from 'reeval/gateway'
import { claudeCode, codex } from 'reeval/harness'

// Strict routing: direct() off, so every cell runs on Vercel AI Gateway or the plan refuses it.
export default defineConfig({
  harnesses: [claudeCode({ model: 'claude-sonnet-4-5' }), codex({ model: 'gpt-5.4-mini' })],
  gateway: [vercel(), direct({ enabled: false })],
})
