import { defineConfig } from 'reeval'
import { codex, goose } from 'reeval/harness'

export default defineConfig({
  harnesses: [codex({ model: 'gpt-5.6-luna' }), goose({ model: 'gemini-3.8-flash' })],
})
