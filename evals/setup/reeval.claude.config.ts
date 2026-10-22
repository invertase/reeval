import { defineConfig } from 'reeval'
import { claudeCode } from 'reeval/harness'

export default defineConfig({
  include: ['*.eval.ts'],
  harness: claudeCode({ model: 'claude-sonnet-5' }),
  timeout: '15m',
})
