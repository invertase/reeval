import { defineConfig } from 'reeval'
import { cursor, grokBuild } from 'reeval/harness'

export default defineConfig({
  harness: [cursor({ model: 'composer-2.5' }), grokBuild({ model: 'grok-4.6' })],
})
