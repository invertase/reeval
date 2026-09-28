import { defineConfig } from 'reeval'
import { antigravity, cursor } from 'reeval/harness'
import { docker } from 'reeval/sandbox'

export default defineConfig({
  harness: [cursor({ model: 'composer-2.5' }), antigravity({ model: 'gemini-3.8-flash-medium' })],
  sandbox: docker(),
})
