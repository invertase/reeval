import { defineConfig } from 'reeval'
import { antigravity, cursor } from 'reeval/harness'

export default defineConfig({
  harnesses: [cursor({ model: 'composer-2.5' }), antigravity({ model: 'gemini-3.8-flash-medium' })],
})
