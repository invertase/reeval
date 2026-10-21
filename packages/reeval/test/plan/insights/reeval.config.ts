import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

export default defineConfig({
  harness: fakeHarness(),
  analysis: { model: 'google/gemini-3.8-flash', maxTokens: 100_000, insightsTimeout: '2m' },
})
