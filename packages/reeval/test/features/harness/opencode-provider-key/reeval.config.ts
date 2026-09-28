import { defineConfig } from 'reeval'
import { opencode } from 'reeval/harness'
import { docker } from 'reeval/sandbox'

// Real OpenCode only (O), on Anthropic with ANTHROPIC_API_KEY: the model's provider picks the key,
// and only that key, as a placeholder, reaches the sandbox.
export default defineConfig({
  harness: opencode({ model: process.env.REEVAL_REAL_MODEL ?? 'anthropic/claude-haiku-4-5' }),
  sandbox: docker(),
})
