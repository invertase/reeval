import { defineConfig } from 'reeval'
import { cursor, goose } from 'reeval/harness'
import { docker } from 'reeval/sandbox'

export default defineConfig({
  harness: [cursor({ model: 'composer-2.5' }), goose({ model: 'gemini-3.8-flash' })],
  sandbox: docker(),
})
