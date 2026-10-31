import { defineConfig } from 'reeval'
import { direct, vercel } from 'reeval/gateway'
import { claudeCode, codex, cursor, goose, grokBuild, pi } from 'reeval/harness'

export default defineConfig({
  harnesses: [
    claudeCode({ model: 'claude-sonnet-4-5' }),
    codex({ model: 'gpt-5.4-mini' }),
    cursor({ model: 'composer-2.5' }),
    goose({ model: 'gemini-3.8-flash' }),
    pi({ model: 'gemini-3.8-flash' }),
    grokBuild({ model: 'grok-4.6' }),
  ],
  gateway: [vercel()],
  profiles: {
    'codex-pin': {
      gateway: [direct(), vercel()],
      defaults: { harnesses: codex({ model: 'gpt-5.4-mini', gateway: 'vercel' }) },
    },
  },
})
