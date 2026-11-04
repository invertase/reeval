import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D).
export default defineConfig({
  harnesses: fakeHarness({
    script: [[{ exec: 'echo deploy-skipped && TOKEN=1 printf contract-42' }]],
  }),
})
