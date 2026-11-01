import { defineConfig } from 'reeval'
import { cursor } from 'reeval/harness'

export default defineConfig({
  harnesses: [cursor({ model: 'composer-2.5', effort: 'medium', params: { fast: 'false' } })],
})
