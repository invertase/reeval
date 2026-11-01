import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

export default defineConfig({
  harnesses: fakeHarness({ id: 'a' }),
  profiles: {
    pr: { limit: { runs: 1 } },
    off: { limit: { compare: false } },
    two: { defaults: { runs: 2 } },
  },
})
