import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

export default defineConfig({
  harness: fakeHarness({}),
  // No analysis.model and no capture.model: the profile's judge is the journey's model.
  profiles: { vision: { judge: { model: 'google/gemini-3.8-flash' } } },
})
