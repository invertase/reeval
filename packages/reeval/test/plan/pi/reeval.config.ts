import { defineConfig } from 'reeval'
import { cursor, pi } from 'reeval/harness'

export default defineConfig({
  harness: [cursor({ model: 'composer-2.5' }), pi({ model: 'gemini-3.8-flash' })],
})
