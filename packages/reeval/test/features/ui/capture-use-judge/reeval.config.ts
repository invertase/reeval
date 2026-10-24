import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

export default defineConfig({
  harness: fakeHarness({}),
  // No capture.model, and analysis.model is an evaluation model that can't drive a journey: the
  // profile's judge is the journey's model.
  analysis: { model: 'typesafe-ai/jev-1.14.0', insights: false },
  profiles: { vision: { judge: { model: 'google/gemini-3.8-flash' } } },
})
