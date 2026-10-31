import { defineConfig } from 'reeval'
import { antigravity, cursor } from 'reeval/harness'

export default defineConfig({
  harnesses: [antigravity({ model: 'gemini-3.8-flash-low' }), cursor({ model: 'composer-2.5' })],
})
