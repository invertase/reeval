import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D).
// REEVAL_SECRETS_FILE holds API_KEY in the sandbox mode.
export default defineConfig({
  // As the agent: print the secret.
  harnesses: fakeHarness({ script: [[{ exec: 'printenv API_KEY' }]] }),
})
