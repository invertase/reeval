import { defineConfig } from 'reeval'
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
    codex({ model: 'gpt-5.6-sol' }),
    codex({ model: 'gpt-5.6-sol', effort: 'high' }),
    claudeCode({ model: 'claude-sonnet-5-5' }),
    claudeCode({ model: 'claude-haiku-4-5' }),
    antigravity({ model: 'gemini-3.8-flash' }),
    antigravity({ model: 'gemini-3.8-flash-low' }),
    opencode({ model: 'google/gemini-3.8-flash' }),
    goose({ model: 'gemini-3.8-flash' }),
    pi({ model: 'gemini-3.8-flash' }),
    grokBuild({ model: 'grok-4.6' }),
    fx({ model: 'gpt-5.4-mini' }),
    cursor({ model: 'composer-2.5', params: { fast: 'false' } }),
    cursor({ model: 'gpt-5.6-luna' }),
  ],
})
