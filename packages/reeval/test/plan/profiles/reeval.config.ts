import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'

export default defineConfig({
  harness: fakeHarness({ id: 'a' }),
  sandbox: fakeSandbox(),
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
