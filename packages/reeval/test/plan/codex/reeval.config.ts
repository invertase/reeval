import { defineConfig } from 'reeval'
import { codex, cursor } from 'reeval/harness'

export default defineConfig({
  harness: [cursor({ model: 'composer-2.5' }), codex({ model: 'gpt-5.4-mini' })],
})
