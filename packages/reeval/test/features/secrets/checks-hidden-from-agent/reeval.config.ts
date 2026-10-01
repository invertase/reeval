import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D).
export default defineConfig({
  // As the agent: print the checks-only secret, or "unset".
  harness: fakeHarness({ script: [[{ exec: 'printenv CHECK_TOKEN || echo unset' }]] }),
})
