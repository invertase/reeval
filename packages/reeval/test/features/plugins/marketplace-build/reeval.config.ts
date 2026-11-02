import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// Docker only: the environments set docker() themselves.
export default defineConfig({
  harnesses: fakeHarness({}),
})
