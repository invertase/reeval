import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D).
// The first turn fails as a provider error would; the second as the API rejecting the key would.
export default defineConfig({
  harnesses: fakeHarness({
    script: [[{ error: '503 Service Unavailable: overloaded' }], [{ refuseKey: 'FAKE_API_KEY' }]],
  }),
})
