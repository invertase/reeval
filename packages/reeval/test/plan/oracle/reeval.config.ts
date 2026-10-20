import { defineConfig } from 'reeval'
import { cursor, fakeHarness } from 'reeval/harness'
import { fakeJudge } from 'reeval/judge'

// The oracle and canary swap the harness and judge only, so each eval keeps its own sandbox.
export default defineConfig({
  harness: cursor({ model: 'composer-2.5' }),
  profiles: {
    oracle: {
      defaults: {
        harness: fakeHarness({ id: 'oracle', files: { 'greet.js': 'export const greet = 1\n' } }),
        judge: { model: fakeJudge({ score: 0.95 }) },
      },
    },
    canary: {
      defaults: {
        harness: fakeHarness({ id: 'canary', files: { 'greet.test.js': '' } }),
        judge: { model: fakeJudge({ score: 0.1 }) },
      },
    },
  },
})
