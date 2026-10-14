import { defineConfig } from 'reeval'
import { claudeCode, cursor, pi } from 'reeval/harness'

export default defineConfig({
  harness: [
    claudeCode({ model: 'claude-sonnet-5', effort: 'high' }),
    claudeCode({ model: 'claude-sonnet-5', effort: 'low' }),
    cursor({ model: 'grok-4.7', effort: 'high', params: { fast: 'true' } }),
    pi({ model: 'gemini-3.8-flash', effort: 'xhigh' }),
  ],
})
