import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

export default defineConfig({
  harnesses: [fakeHarness({ id: 'a' }), fakeHarness({ id: 'b' })],
  budget: { attempts: 20 },
  profiles: {
    // A limit below the best-of makes it a fixed count.
    pr: { limit: { runs: 1 } },
    nightly: { defaults: { runs: { bestOf: 7 } } },
  },
})
