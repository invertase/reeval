import { defineConfig } from 'reeval'
import { cursor, goose } from 'reeval/harness'

export default defineConfig({
  harness: [cursor({ model: 'composer-2.5' }), goose({ model: 'gemini-3.8-flash' })],
})
