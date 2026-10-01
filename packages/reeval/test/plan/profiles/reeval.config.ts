import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

export default defineConfig({
  harness: fakeHarness({ id: 'a' }),
  defaultProfile: { ci: 'pr' },
  profiles: {
    pr: {
      limit: { runs: 1, compare: false, harness: ['a'] },
      budget: { attempts: 5 },
      tags: ['!nightly-only'],
    },
    nightly: {
      defaults: { runs: 3, harness: [fakeHarness({ id: 'a' }), fakeHarness({ id: 'b' })] },
    },
  },
})
