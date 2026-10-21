import { defineConfig } from 'reeval'
import { claudeCode, grokBuild } from 'reeval/harness'

export default defineConfig({
  harness: [claudeCode({ model: 'claude-sonnet-5' }), grokBuild({ model: 'grok-4.6' })],
})
