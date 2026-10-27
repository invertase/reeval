import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D).
export default defineConfig({
  harness: fakeHarness({}),
  // One attempt a cell, where a compare would otherwise run 4 a side.
  runs: 1,
  record: 'always',
  history: { artifacts: 'failures' },
})
