import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { docker } from 'reeval/sandbox'

export default defineConfig({
  harnesses: fakeHarness(),
  sandbox: docker({ from: 'node:22-bookworm' }),
})
