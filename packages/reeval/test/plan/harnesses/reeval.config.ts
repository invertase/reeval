import { defineConfig } from 'reeval'
import { claudeCode, cursor } from 'reeval/harness'

export default defineConfig({
  harnesses: [cursor({ model: 'composer-2.5' }), claudeCode({ model: 'claude-sonnet-5' })],
})
