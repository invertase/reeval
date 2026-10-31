import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { resume } from './evals/env.ts'

export default defineConfig({
  harnesses: fakeHarness({}),
  environments: resume,
})
