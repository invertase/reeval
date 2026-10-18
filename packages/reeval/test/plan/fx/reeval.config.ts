import { defineConfig } from 'reeval'
import { cursor, fx } from 'reeval/harness'

export default defineConfig({
  harness: [cursor({ model: 'composer-2.5' }), fx({ model: 'anthropic/claude-sonnet-5' })],
})
