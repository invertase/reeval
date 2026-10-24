import { defineConfig } from 'reeval'
import { claudeCode, cursor } from 'reeval/harness'

export default defineConfig({
  harness: [cursor({ model: 'composer-2.5' }), claudeCode({ model: 'claude-sonnet-5' })],
  judge: { model: 'google/gemini-3.8-flash' },
  runs: 2,
})
