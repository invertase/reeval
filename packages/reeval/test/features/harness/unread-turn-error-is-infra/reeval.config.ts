import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D).
// Every turn fails as an outage would, which c.send returns rather than throws.
export default defineConfig({
  harnesses: fakeHarness({ script: [[{ error: '503 Service Unavailable: overloaded' }]] }),
})
