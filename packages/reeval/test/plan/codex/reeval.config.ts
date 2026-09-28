import { defineConfig } from 'reeval'
import { codex, cursor } from 'reeval/harness'
import { docker } from 'reeval/sandbox'

export default defineConfig({
  harness: [cursor({ model: 'composer-2.5' }), codex({ model: 'gpt-5.4-mini' })],
  sandbox: docker(),
})
