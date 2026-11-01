import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

/** No default environments, so nothing but the eval names one. */
export default defineConfig({
  harnesses: fakeHarness(),
})
