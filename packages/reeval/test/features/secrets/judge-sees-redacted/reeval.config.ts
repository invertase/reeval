import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeJudge } from 'reeval/judge'

// REEVAL_FIXTURE_SANDBOX picks the tier: the fake sandbox (F) by default, or docker (D).
export default defineConfig({
  // As the agent: print the secret it was given.
  harness: fakeHarness({ script: [[{ exec: 'printenv AGENT_TOKEN' }]] }),
  judge: { model: fakeJudge({ score: 1 }) },
})
