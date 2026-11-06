import { defineConfig } from 'reeval'
import { goose } from 'reeval/harness'

// Real Goose only (O), with GOOGLE_GENERATIVE_AI_API_KEY: each turn's tokens, which Goose's ACP
// server reports for its last model call only, come from its usage_ledger, every call summed.
export default defineConfig({
  harnesses: goose({ model: process.env.REEVAL_REAL_MODEL ?? 'google/gemini-3.8-flash' }),
})
