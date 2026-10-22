import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

export default defineConfig({
  harness: fakeHarness(),
  analysis: { model: 'anthropic/claude-sonnet-5', maxTokens: 100_000 },
})
