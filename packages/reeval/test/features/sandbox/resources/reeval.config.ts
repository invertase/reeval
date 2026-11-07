import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// Docker only: the fake sandbox runs on the host, with no container of its own to read.
export default defineConfig({
  harnesses: fakeHarness(),
})
