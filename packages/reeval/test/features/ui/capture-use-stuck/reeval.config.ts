import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

export default defineConfig({
  harness: fakeHarness({}),
  capture: { model: 'anthropic/scripted-stuck' },
})
