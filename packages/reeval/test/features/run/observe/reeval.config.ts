import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { observed } from './evals/env.ts'

export default defineConfig({
  harnesses: fakeHarness({}),
  environments: observed,
})
