import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// The fake sandbox only: what the eval code reads doesn't depend on the sandbox.
// REEVAL_SECRETS_FILE holds API_KEY in the sandbox mode.
export default defineConfig({
  harnesses: fakeHarness({ script: [[{ exec: 'true' }]] }),
})
