import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// Docker only: the fake sandbox has no limits to set.
export default defineConfig({
  harnesses: fakeHarness(),
})
