import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

export default defineConfig({
  harness: fakeHarness({}),
  capture: { timeout: '60s' },
})
