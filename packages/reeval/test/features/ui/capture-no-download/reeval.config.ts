import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

export default defineConfig({
  harnesses: fakeHarness({}),
  capture: { timeout: '60s' },
})
