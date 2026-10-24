import { defineConfig } from 'reeval'
import { direct, openrouter } from 'reeval/gateway'
import {
  antigravity,
  claudeCode,
  codex,
  cursor,
  fx,
  goose,
  grokBuild,
  opencode,
  pi,
} from 'reeval/harness'

export default defineConfig({
  harness: [
    claudeCode({ model: 'claude-haiku-4-5' }),
    codex({ model: 'gpt-5.4-mini' }),
    goose({ model: 'gemini-3.8-flash' }),
    opencode({ model: 'google/gemini-3.8-flash' }),
    grokBuild({ model: 'grok-4.6' }),
    cursor({ model: 'composer-2.5' }),
    antigravity({ model: 'gemini-3.8-flash-low' }),
    fx({ model: 'gpt-5.5' }),
    pi({ model: 'gemini-3.8-flash' }),
  ],
  gateway: [openrouter(), direct()],
  profiles: {
    fallbacks: { gateway: [openrouter({ fallbacks: true }), direct()] },
  },
})
