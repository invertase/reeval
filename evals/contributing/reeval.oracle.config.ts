// The contributing topic's oracle: a fake agent that applies each task's merged change, so every
// check must pass (the shared reeval.fake.config.ts is the canary: every check that reads the
// agent's work fails).
// `pnpm reeval run --config evals/contributing/reeval.oracle.config.ts`
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeSandbox } from 'reeval/sandbox'

export default defineConfig({
  include: ['*.eval.ts'],
  harness: fakeHarness({
    script: [[{ exec: 'git apply ~/oracle.patch' }]],
    text: 'Applied the merged change.',
  }),
  sandbox: fakeSandbox(),
  timeout: '45m',
})
