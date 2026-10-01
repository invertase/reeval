import { defineConfig } from 'reeval'
import { cursor, opencode } from 'reeval/harness'

export default defineConfig({
  harness: [cursor({ model: 'composer-2.5' }), opencode({ model: 'google/gemini-3.8-flash' })],
})
