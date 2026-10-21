import { defineConfig } from 'reeval'
import { fx, opencode, pi } from 'reeval/harness'

export default defineConfig({
  harness: [
    opencode({ model: 'google/gemini-3.8-flash' }),
    pi({ model: 'gemini-3.8-flash' }),
    fx({ model: 'gpt-4.1' }),
  ],
})
