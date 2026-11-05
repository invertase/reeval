import { defineConfig } from 'reeval'
import { goose } from 'reeval/harness'

// Real Goose only (O), on OpenAI with OPENAI_API_KEY: the model's provider picks the key, and
// only that key, as a placeholder, reaches the sandbox.
export default defineConfig({
  harnesses: goose({ model: process.env.REEVAL_REAL_MODEL ?? 'openai/gpt-5.4-mini' }),
})
