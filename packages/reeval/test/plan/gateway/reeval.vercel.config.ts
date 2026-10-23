import { defineConfig } from 'reeval'
import { direct, vercel } from 'reeval/gateway'
import { claudeCode, codex, cursor } from 'reeval/harness'

export default defineConfig({
  harness: [
    claudeCode({ model: 'claude-sonnet-4-5' }),
    codex({ model: 'gpt-5.4-mini' }),
    cursor({ model: 'composer-2.5' }),
  ],
  gateway: [vercel(), direct()],
  profiles: {
    'codex-pin': {
      gateway: [direct(), vercel()],
      defaults: { harness: codex({ model: 'gpt-5.4-mini', gateway: 'vercel' }) },
    },
  },
})
