import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// Docker only: the fake sandbox has no memory limit to hit.
export default defineConfig({
  harness: fakeHarness(),
})
